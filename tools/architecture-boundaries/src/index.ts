import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { buildSync, type Metafile } from "esbuild";
import {
  sealCatalogCompilerClosureFacts,
  type CatalogCompilerClosureFactV1,
} from "../../../specs/catalog-compiler/src/index.ts";
import {
  sealReleaseQualifiedCapabilitySetV1,
  type ReleaseQualifiedCapabilityRefV1,
  type ReleaseQualifiedCapabilitySetV1,
} from "../../../specs/capability-index/src/index.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  currentCatalogCapabilityProposalSpecs,
  currentCatalogCompilerEntrypointSpecs,
  currentCatalogInput,
  readCurrentCatalogInput,
  selectCatalogCompilerClosureCandidates,
} from "../../catalog-generator/src/current-release.ts";
import {
  generateCatalogWithImpact,
  verifyCatalogLedger,
} from "../../catalog-generator/src/index.ts";
import { verifyCurrentCatalogGeneration } from "../../catalog-generator/src/verification-owner.ts";
import {
  CATALOG_COMPILER_OBSERVER_ENTRYPOINT,
  CATALOG_GENERATION_VERIFIER_ENTRYPOINT,
  CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT,
  assertCatalogGenerationVerificationReceiptExact,
  catalogCandidateDenominatorRoot,
  catalogCompilerFactsRoot,
  catalogIndexDenominatorRoot,
  createCatalogGenerationVerificationReceiptV1,
  type CatalogGenerationVerificationReceiptV1,
} from "../../catalog-generator/src/verification-receipt.ts";
import {
  collectRustBuildAdapterFacts,
  type RustBuildAdapterFactsV1,
} from "./build-adapters/rust.ts";
import {
  collectFoundryBuildGraphFacts,
  type FoundryBuildGraphFactsV1,
} from "./build-adapters/solidity.ts";
import {
  decodeRuntimeBoundaryProjectionV1,
  runtimeBoundaryProjectionRootV1,
  type RuntimeBoundaryProjectionV1,
  type RuntimeBoundaryProjectionPayloadV1,
} from "../../../specs/runtime-acceptance-facts/src/runtime-boundary-projection.ts";
import {
  buildExactPreReleaseRestartControllerArtifactV1,
} from "../../pre-release-restart-controller/src/bundle-builder.ts";

const BOUNDARY_GIT_EXECUTABLE_PATH = "/usr/bin/git";
const BOUNDARY_CANONICAL_REMOTE_URL_V1 = "https://github.com/EuniceLeeee/c0ffeebabe.eth.git";

function boundaryGitEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    PATH: "/usr/bin:/bin",
  };
}

/**
 * This package is a source/build fact collector.  It never reads a runtime
 * object and it never emits a legacy=0 claim.  The caller may use its receipt
 * as an observation in the independent acceptance core, but the receipt is
 * not itself a production verdict.
 */

export type Language = "typescript" | "javascript" | "rust" | "solidity" | "metadata";
export type FileClass =
  | "acceptance-pure-core"
  | "acceptance-collector"
  | "central"
  | "production-runtime"
  | "family"
  | "strategy"
  | "valuation-owner"
  | "authoring"
  | "generated"
  | "reference-only"
  | "metadata";
export type DiagnosticKind = "fail" | "invalid";

export interface BoundaryDiagnostic {
  readonly kind: DiagnosticKind;
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly offset: number | null;
  readonly caseId?: string;
}

export interface TrackedFile {
  readonly path: string;
  readonly mode: string;
  readonly blobSha: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly language: Language;
  readonly fileClass: FileClass;
}

export interface GraphNode {
  readonly path: string;
  readonly configPath: string;
  readonly root: boolean;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  /** NodeNext's usage condition used to resolve this edge, when applicable. */
  readonly resolutionMode?: "import" | "require";
}

export interface CompilerSummary {
  readonly typescriptVersion: string;
  readonly compilerVersionRoot: string;
  readonly configPaths: readonly string[];
  readonly configRoots: string;
  readonly graphRoot: string;
  readonly packageManifestRoot: string;
  readonly externalDependencyRoot: string;
  readonly languageBuildRoot: string;
  readonly externalDependencies: readonly string[];
  readonly workspaceNames: readonly string[];
}

export interface LanguageBuildFactsV1 {
  readonly rust: RustBuildAdapterFactsV1 | null;
  readonly solidity: FoundryBuildGraphFactsV1 | null;
  readonly rootDigest: string;
}

export interface ImplementationClosureFile {
  readonly path: string;
  readonly blobSha: string;
  readonly contentSha256: string;
  readonly byteLength: number;
}

export interface ImplementationConfigChain {
  readonly rootPath: string;
  readonly files: readonly ImplementationClosureFile[];
  readonly edges: readonly GraphEdge[];
}

export interface ImplementationCompilerInput {
  readonly kind: "tracked" | "npm" | "typescript-lib" | "typescript-compiler" | "node-runtime";
  /** Stable logical identity. Absolute checkout/install paths are forbidden. */
  readonly logicalPath: string;
  readonly blobSha: string | null;
  readonly packageName: string | null;
  readonly packageVersion: string | null;
  readonly packageRelativePath: string | null;
  readonly packageManifestSha256: string | null;
  readonly lockRecordPath: string | null;
  readonly lockRecordHash: string | null;
  readonly contentSha256: string;
  readonly compilerTextSha256: string | null;
  readonly byteLength: number;
}

export interface ImplementationClosure {
  /** Repository-relative compiler-visible source path for this entrypoint. */
  readonly entrypoint: string;
  /** Stable identity when the same source path is exposed by multiple roots. */
  readonly entrypointId: string;
  readonly kind: "compiler-root" | "package-entrypoint";
  readonly packageName: string | null;
  readonly packageManifestPath: string | null;
  readonly configPath: string;
  readonly tsconfigRoot: string;
  readonly configChain: ImplementationConfigChain;
  readonly optionsRoot: string;
  readonly programInputs: readonly ImplementationCompilerInput[];
  readonly programInputSetRoot: string;
  readonly typescriptVersion: string;
  readonly packageManifestRoot: string;
  readonly externalDependencyRoot: string;
  readonly files: readonly ImplementationClosureFile[];
  readonly edges: readonly GraphEdge[];
  readonly closureDigest: string;
}

/**
 * The catalog compiler consumes only this narrow projection of a validated
 * boundary receipt.  It intentionally omits source files, ASTs, and mutable
 * compiler objects: the boundary owns those observations and the catalog
 * generator may only exact-join the resulting identity and roots.
 */
export interface CatalogCompilerClosureBindingV1 {
  readonly modulePath: string;
  readonly exportName: string;
  readonly entrypointId: string;
}

/**
 * One capability proposal declaration bound to the exact compiler closure
 * that owns its interpreter.  This is build identity, not a qualification
 * verdict; the catalog compiler never creates the owner identity itself.
 */
export interface CatalogCapabilityProposalBindingV1 extends CatalogCompilerClosureBindingV1 {
  readonly capabilityId: string;
  readonly version: string;
  readonly schemaHash: ReleaseQualifiedCapabilityRefV1["schemaHash"];
  readonly interpreterHash: ReleaseQualifiedCapabilityRefV1["interpreterHash"];
}

/**
 * Semantic release roles are references to compiler-derived closures, never a
 * manually maintained file list.  The generated manifest is supplied by
 * release governance; this package only resolves the exact entrypoint id and
 * recomputes its compiler closure facts.
 */
export type ReleaseClosureRoleV1 =
  | "generic-core"
  | "qualified-runner"
  | "predicate-adapter"
  | "qualification-oracle"
  | "material-provider"
  | "release-runtime";

/** A generated release manifest binding one compiler closure to one module export. */
export interface ReleaseRoleBindingV1 {
  readonly entrypointId: string;
  readonly modulePath: string;
  readonly exportName: string;
}

/** The externally qualified runner export bound to exact tracked source bytes. */
export interface ReleaseQualifiedRunnerBindingV1 extends ReleaseRoleBindingV1 {
  readonly implementationExportDigest: string;
}

/** One exact predicate adapter leaf in the release BOM. */
export interface ReleasePredicateBomEntryV1 extends ReleaseRoleBindingV1 {
  readonly predicateId: string;
  readonly predicateSpecDigest: string;
  readonly predicateProgramDescriptorDigest: string;
  readonly oracleProgramDescriptorDigest: string;
  readonly adapterVersion: string;
  readonly oracleVersion: string;
  readonly compositionLeafDigest: string;
  readonly predicateImplementationExportDigest: string;
  readonly oracleImplementationExportDigest: string;
  readonly commonEnvelopeRoleContractVersion: string;
  readonly materialProviderContractDigest: string;
  readonly materialProviderImplementationExportDigest: string;
  /** Qualification-only oracle bound to this predicate, not a global oracle. */
  readonly oracleEntrypointId: string;
  readonly oracleModulePath: string;
  readonly oracleExportName: string;
  readonly materialProviderEntrypointId: string;
  readonly materialProviderModulePath: string;
  readonly materialProviderExportName: string;
}

/**
 * Generated, untrusted release-role facts.  The boundary recomputes every
 * digest and checks the bindings against compiler-visible source; callers may
 * not select a role by filename convention alone.
 */
export interface ReleaseRoleManifestV1 {
  readonly schemaVersion: 1;
  readonly commonEnvelopeRoleContractVersion: string;
  readonly genericCore: ReleaseRoleBindingV1;
  readonly qualifiedRunner: ReleaseQualifiedRunnerBindingV1;
  readonly predicateAdapters: readonly ReleasePredicateBomEntryV1[];
  readonly releaseRuntime: ReleaseRoleBindingV1;
  readonly predicateCompositionRootDigest: string;
  readonly rootDigest: string;
}

export interface ReleaseClosureRefV1 {
  readonly role: ReleaseClosureRoleV1;
  readonly entrypointId: string;
  readonly entrypoint: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly predicateId: string | null;
  readonly predicateSpecDigest: string | null;
  readonly predicateProgramDescriptorDigest: string | null;
  readonly oracleProgramDescriptorDigest: string | null;
  readonly adapterVersion: string | null;
  readonly oracleVersion: string | null;
  readonly compositionLeafDigest: string | null;
  readonly commonEnvelopeRoleContractVersion: string | null;
  readonly materialProviderContractDigest: string | null;
  readonly implementationExportDigest: string | null;
  readonly closureDigest: string;
  readonly programInputSetRoot: string;
}

export interface ReleaseClosureFactsV1 {
  readonly schemaVersion: 1;
  readonly genericCore: ReleaseClosureRefV1;
  readonly qualifiedRunner: ReleaseClosureRefV1;
  readonly predicateAdapters: readonly ReleaseClosureRefV1[];
  readonly qualificationOracles: readonly ReleaseClosureRefV1[];
  readonly materialProviders: readonly ReleaseClosureRefV1[];
  readonly releaseRuntime: ReleaseClosureRefV1;
  readonly predicateCompositionRootDigest: string;
  readonly commonEnvelopeRoleContractVersion: string;
  readonly roleManifestRootDigest: string;
  readonly rootDigest: string;
}

export interface ReleaseClosureDerivationV1 {
  readonly facts: ReleaseClosureFactsV1 | null;
  readonly diagnostics: readonly BoundaryDiagnostic[];
}

export interface BoundaryOptions {
  /** Absolute or relative repository root. Defaults to this package's repo. */
  readonly gitRoot?: string;
  /** Production default is true. Tests may explicitly collect a local fixture. */
  readonly requirePushed?: boolean;
}

export interface BoundaryReceipt {
  readonly schemaVersion: 1;
  readonly gate: "aloha.machine-enforced-boundary";
  readonly verdict: "pass" | "fail" | "invalid";
  readonly candidate: {
    readonly gitRoot: string;
    readonly branch: string | null;
    readonly headSha: string | null;
    readonly upstreamSha: string | null;
    readonly remoteRef: string | null;
    readonly remoteSha: string | null;
    readonly clean: boolean;
    readonly pushed: boolean;
  };
  readonly denominator: {
    readonly scannedFileSetRoot: string;
    readonly manifestRoot: string;
    readonly files: readonly TrackedFile[];
  };
  readonly compiler: CompilerSummary;
  readonly languageBuild: LanguageBuildFactsV1;
  readonly graph: {
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly GraphEdge[];
  };
  readonly implementationClosures: readonly ImplementationClosure[];
  /** Source/build receipt for external qualification pinning; never authority by itself. */
  readonly catalogVerification: CatalogGenerationVerificationReceiptV1 | null;
  readonly releaseRoleManifest: ReleaseRoleManifestV1 | null;
  readonly releaseClosures: ReleaseClosureFactsV1 | null;
  readonly diagnostics: readonly BoundaryDiagnostic[];
  readonly mutationCorpus: {
    readonly root: string;
    readonly cases: readonly MutationResult[];
  };
  readonly claims: {
    readonly sourceBuildClosure: "observed";
    readonly runtimeLegacyZero: "not-asserted";
    readonly productionAuthority: "not-observed";
  };
}

/**
 * Bounded machine output for the Boundary CLI.  The in-process
 * `BoundaryReceipt` remains the complete fact tree used by all validators;
 * this projection publishes the existing content roots plus roots for the
 * two previously expanded-only collections.
 */
export interface BoundaryMachineReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.machine-enforced-boundary-receipt";
  readonly gate: BoundaryReceipt["gate"];
  readonly verdict: BoundaryReceipt["verdict"];
  readonly candidate: BoundaryReceipt["candidate"];
  readonly roots: {
    readonly scannedFileSetRoot: string;
    readonly boundaryManifestRoot: string;
    readonly compilerVersionRoot: string;
    readonly compilerConfigRoot: string;
    readonly compilerGraphRoot: string;
    readonly packageManifestRoot: string;
    readonly externalDependencyRoot: string;
    readonly languageBuildRoot: string;
    readonly implementationClosureSetRoot: string;
    readonly catalogVerificationRoot: string | null;
    readonly releaseRoleManifestRoot: string | null;
    readonly releaseClosureRoot: string | null;
    readonly diagnosticSetRoot: string;
    readonly mutationCorpusRoot: string;
  };
  readonly counts: {
    readonly trackedFiles: number;
    readonly graphNodes: number;
    readonly graphEdges: number;
    readonly implementationClosures: number;
    readonly implementationCompilerInputs: number;
    readonly diagnostics: number;
    readonly mutationCases: number;
  };
  readonly claims: BoundaryReceipt["claims"];
  readonly rootDigest: string;
}

export interface QualifiedRunnerBoundarySnapshotV1 {
  readonly candidateGitRoot: string;
  readonly candidateReleaseCommit: string;
  readonly releaseRoleManifestRoot: string;
  readonly qualifiedRunner: ReleaseClosureRefV1;
}

export interface QualifiedPreReleaseControllerBoundaryEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.qualified-pre-release-controller-boundary-evidence";
  readonly candidateReleaseCommit: string;
  readonly controllerBundleSha256: Hash;
  readonly controllerSourceInputRoot: Hash;
  readonly controllerMetafileRoot: Hash;
  readonly controllerImplementationClosureDigest: Hash;
  readonly boundaryImplementationClosureDigest: Hash;
  readonly boundaryProgramInputSetRoot: Hash;
  readonly controllerSystemdUnitSha256: Hash;
  readonly targetSystemdUnitSha256: Hash;
  readonly installContract: Readonly<Record<string, string | number | boolean>>;
  readonly externalBuiltins: readonly string[];
  readonly searcherRuntimeBundleMember: false;
  readonly evidenceRoot: Hash;
}

interface IssuedProductionBoundaryStateV1 {
  readonly snapshot: QualifiedRunnerBoundarySnapshotV1;
  readonly releaseClosures: ReleaseClosureFactsV1;
  readonly implementationClosures: readonly ImplementationClosure[];
  readonly denominator: BoundaryReceipt["denominator"];
  readonly compiler: CompilerSummary;
  readonly languageBuild: LanguageBuildFactsV1;
  readonly git: Readonly<{
    readonly branch: string;
    readonly upstreamRef: string;
    readonly remoteRef: string;
    readonly headSha: string;
    readonly upstreamSha: string;
    readonly remoteSha: string;
  }>;
}

const ISSUED_PRODUCTION_BOUNDARY_RECEIPTS = new WeakMap<object, IssuedProductionBoundaryStateV1>();

function freezeIssuedBoundaryValueV1<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeIssuedBoundaryValueV1(child, seen);
  return Object.freeze(value);
}

export interface QualifiedRunnerReleaseRequirementBindingV1 {
  readonly predicateId: string;
  readonly predicateSpecDigest: string;
  readonly predicateCompositionLeafDigest: string;
  readonly verifierCertificateId: string;
}

export interface QualifiedRunnerReleaseApprovalBindingV1 {
  readonly candidateReleaseCommit: string;
  readonly releaseRoleManifestRoot: string;
  readonly predicateCompositionRootDigest: string;
  readonly gateCoreRuntimeClosureDigest: string;
  readonly gateCoreImplementationClosureDigest: string;
  readonly qualifiedRunnerImplementationClosureDigest: string;
  readonly qualifiedRunnerImplementationExportDigest: string;
  readonly releaseAcceptanceRequirements: readonly QualifiedRunnerReleaseRequirementBindingV1[];
}

export interface QualifiedRunnerPredicateQualificationBindingV1 {
  readonly release: {
    readonly predicateId: string;
    readonly predicateSpecDigest: string;
    readonly predicateCompositionLeafDigest: string;
    readonly predicateCompositionRootDigest: string;
    readonly gateCoreRuntimeClosureDigest: string;
    readonly gateCoreImplementationClosureDigest: string;
    readonly verifierQualificationId: string;
  };
  readonly verifierCertificate: {
    readonly certificateId: string;
    readonly predicateSpecDigest: string;
    readonly predicateImplementationDigest: string;
    readonly predicateImplementationExportDigest: string;
    readonly predicateProgramDescriptorDigest: string;
    readonly oracleProgramDescriptorDigest: string;
    readonly oracleImplementationClosureDigest: string;
    readonly oracleImplementationExportDigest: string;
    readonly predicateCompositionLeafDigest: string;
    readonly gateCoreImplementationClosureDigest: string;
  };
}

export interface MutationExpectation {
  readonly caseId: string;
  readonly path: string;
  readonly offset: number;
  readonly code: string;
}

export interface MutationCase {
  readonly caseId: string;
  readonly path: string;
  readonly source: string;
  readonly expected: readonly MutationExpectation[];
  readonly scanOptions?: SourceScanOptions;
}

export interface MutationResult {
  readonly caseId: string;
  readonly expected: readonly MutationExpectation[];
  readonly actual: readonly MutationExpectation[];
  readonly pass: boolean;
}

const SOURCE_EXTENSIONS = new Map<string, Language>([
  [".ts", "typescript"], [".tsx", "typescript"], [".mts", "typescript"], [".cts", "typescript"],
  [".js", "javascript"], [".jsx", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"],
  [".rs", "rust"], [".sol", "solidity"],
]);
const METADATA_NAMES = new Set([
  ".gitignore", ".gitattributes", ".npmrc", "LICENSE", "README", "README.md", "AGENTS.md", "CLAUDE.md",
]);
const METADATA_EXTENSIONS = new Set([".json", ".md", ".lock", ".toml", ".txt", ".yaml", ".yml"]);
const CONFIG_NAMES = new Set(["package.json", "tsconfig.json", "jsconfig.json", "foundry.toml", "remappings.txt"]);
// `src/` remains a conventional package-local root for standalone fixtures;
// every other repository source root must be one of the declared production
// roots below rather than silently becoming metadata.
const DECLARED_SOURCE_ROOTS = new Set([
  "acceptance",
  "apps",
  "contracts",
  "families",
  "generated",
  "packages",
  "specs",
  "strategies",
  "tools",
  "runtime",
  "valuation-owners",
  "src",
]);
const NODE_BUILTIN_PREFIXES = ["node:"];
const PURE_GOVERNANCE_NODE_BUILTINS = new Set(["node:crypto", "node:util"]);
/** Pure, stateless signature verification is frozen governance code even
 * though this legacy-neutral package lives under packages/.  It has no
 * runtime authority or environment ownership and is admitted only as a
 * dependency of acceptance core. */
const FROZEN_PURE_CORE_PATHS = new Set([
  "packages/external-qualification-verifier/src/index.ts",
]);
const GATE_CORE_PACKAGE_PATH = "acceptance/gate-core/package.json";
const RELEASE_GENERIC_CORE_PATH = "acceptance/gate-core/src/index.ts";
const RELEASE_RUNTIME_PATH = "acceptance/gate-core/src/generated/release-runtime.ts";
const GATE_CORE_RELEASE_TARGET = "./src/generated/release-runtime.ts";
const RELEASE_COMPOSITION_PATH = "acceptance/gate-core/src/release-composition.ts";
const RELEASE_PREDICATE_COMPOSITION_PATH = "acceptance/gate-core/src/generated/predicate-composition.ts";
const RELEASE_AUTHORITY_PATH = "acceptance/gate-core/src/generated/release-authority.ts";
const GATE_CORE_MATERIAL_PROVIDER_STATE_PATH = "acceptance/gate-core/src/internal/material-provider-state.ts";
const GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH = "acceptance/gate-core/src/internal/common-envelope-authority-issuer.ts";
const GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH = "acceptance/gate-core/src/internal/predicate-domain-material-state.ts";
const GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH = "acceptance/gate-core/src/internal/predicate-domain-material-issuer.ts";
const GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH = "acceptance/gate-core/src/release-material-assembler.ts";
const COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH = "acceptance/collectors/src/material-providers/shared.ts";
const QUALIFIED_RELEASE_RUNNER_OWNER_PATH = "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts";
const QUALIFIED_RELEASE_RUNTIME_ENTRY_PATH = "tools/runtime-release-packager/src/internal/qualified-release-runtime-entry.ts";
const FRESH_QUALIFIED_RUNNER_HOST_OWNER_PATH = "tools/runtime-release-packager/src/internal/fresh-qualified-runner-host-owner.ts";
const COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH = "acceptance/collectors/src/production-predicate-material-source.ts";
const COLLECTOR_PREDICATE_MATERIAL_PUBLIC_PATH = "acceptance/collectors/src/predicate-material-source.ts";
const COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH = "acceptance/collectors/src/internal/predicate-material-source-owner.ts";
const COLLECTOR_PREDICATE_MATERIAL_SOURCE_ISSUER_PATH = "acceptance/collectors/src/internal/predicate-material-source-issuer.ts";
const COLLECTOR_PREDICATE_MATERIAL_BRIDGE_ISSUER_PATH = "acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts";
const SCHEDULER_AUTHORITY_PATH = "packages/scheduler/src/generated/qualified-executor-authority.ts";
const FAMILY_EXECUTION_COMPOSITION_PATH = "packages/work-plane/src/generated/family-execution-composition.ts";
const RUNTIME_RELEASE_PUBLIC_PATH = "packages/runtime-release-authority/src/index.ts";
const RUNTIME_RELEASE_BOOTSTRAP_PATH = "packages/runtime-release-authority/src/internal/bootstrap.ts";
const RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH = "packages/runtime-release-authority/src/internal/http-family-physical-owner.ts";
const RUNTIME_RELEASE_DISCOVERY_OWNER_PATH = "packages/runtime-release-authority/src/internal/discovery-owner.ts";
const RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH = "packages/runtime-release-authority/src/internal/discovery-source-authority-owner.ts";
const RUNTIME_RELEASE_STATE_PATH = "packages/runtime-release-authority/src/internal/state.ts";
const RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH = "packages/runtime-release-authority/src/internal/performance-runtime-owner.ts";
const RUNTIME_RELEASE_STARTUP_OWNER_PATH = "packages/runtime-release-authority/src/internal/searcher-startup-owner.ts";
const RUNTIME_RELEASE_STRATEGY_OWNER_PATH = "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts";
const RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH = "packages/runtime-release-authority/src/internal/full-family-terminal-owner.ts";
const RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH = "packages/runtime-release-authority/src/full-family-terminal-consumer.ts";
const RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH = "packages/runtime-release-authority/src/internal/full-graph-coarse-sweep-owner.ts";
const RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH = "packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts";
const FULL_FAMILY_OBSERVER_PATH = "acceptance/collectors/src/full-family-observer.ts";
const FULL_FAMILY_OBSERVATION_PORT_PUBLIC_PATH = "packages/full-family-observation-port/src/index.ts";
const FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH = "packages/full-family-observation-port/src/internal/owner.ts";
const FULL_FAMILY_COLLECTOR_PORT_PATH = "acceptance/collectors/src/production-full-family-port.ts";
const SIX_STEP_OBSERVATION_PORT_PUBLIC_PATH = "packages/six-step-observation-port/src/index.ts";
const SIX_STEP_OBSERVATION_PORT_OWNER_PATH = "packages/six-step-observation-port/src/internal/owner.ts";
const SIX_STEP_COLLECTOR_PORT_PATH = "acceptance/collectors/src/production-six-step-port.ts";
const SIX_STEP_PROCESS_PUBLIC_PATH = "packages/six-step-process-evidence/src/index.ts";
const SIX_STEP_PROCESS_OWNER_PATH = "packages/six-step-process-evidence/src/internal/owner.ts";
const SIX_STEP_COMPLETE_APPEND_OWNER_PATH = "packages/six-step-process-evidence/src/internal/complete-append-owner.ts";
const SIX_STEP_WINDOW_SELECTION_OWNER_PATH = "packages/six-step-process-evidence/src/internal/window-selection-owner.ts";
const RUNTIME_RELEASE_SIX_STEP_TERMINAL_OWNER_PATH = "packages/runtime-release-authority/src/internal/six-step-terminal-owner.ts";
const RUNTIME_RELEASE_SIX_STEP_TERMINAL_CONSUMER_PATH = "packages/runtime-release-authority/src/six-step-terminal-consumer.ts";
const RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH = "packages/runtime-release-authority/src/internal/six-step-production-owner.ts";
const RUNTIME_RELEASE_SIX_STEP_PRODUCTION_CONSUMER_PATH = "packages/runtime-release-authority/src/six-step-production-consumer.ts";
const EVIDENCE_EMITTER_PUBLIC_PATH = "packages/evidence-emitter/src/index.ts";
const EVIDENCE_EMITTER_SIX_STEP_PRODUCTION_OWNER_PATH = "packages/evidence-emitter/src/internal/six-step-production-owner.ts";
const CHECKPOINT_PUBLIC_PATH = "packages/checkpoint/src/index.ts";
const CHECKPOINT_SIX_STEP_ARTIFACT_PORT_OWNER_PATH = "packages/checkpoint/src/internal/six-step-artifact-port-owner.ts";
const SEARCH_PIPELINE_PUBLIC_PATH = "packages/search-pipeline/src/index.ts";
const SEARCH_PIPELINE_SIX_STEP_TAIL_PORT_OWNER_PATH = "packages/search-pipeline/src/internal/six-step-tail-port-owner.ts";
const TERMINAL_PHASE_OBSERVATION_PORT_PUBLIC_PATH = "packages/terminal-phase-observation-port/src/index.ts";
const TERMINAL_PHASE_OBSERVATION_PORT_OWNER_PATH = "packages/terminal-phase-observation-port/src/internal/owner.ts";
const TERMINAL_PHASE_COLLECTOR_PORT_PATH = "acceptance/collectors/src/production-terminal-phase-port.ts";
const SIX_STEP_OBSERVER_PATH = "acceptance/collectors/src/six-step-observer.ts";
const FINAL_DURABLE_WINDOW_PUBLIC_PATH = "packages/final-durable-window/src/index.ts";
const FINAL_DURABLE_WINDOW_OWNER_PATH = "packages/final-durable-window/src/internal/owner.ts";
const SEARCHER_PRODUCTION_EVIDENCE_PATH = "apps/searcher-runtime/src/production-evidence.ts";
const SEARCHER_APPLICATION_OWNER_PATH = "apps/searcher-runtime/src/internal/application-owner.ts";
const STARTUP_RUNTIME_PUBLIC_PATH = "packages/startup-runtime/src/index.ts";
const SCHEDULER_SHARED_RUNTIME_OWNER_PATH = "packages/scheduler/src/internal/shared-runtime-owner.ts";
const SCHEDULER_AUTHORITY_CONSUMER_PATH = "packages/scheduler/src/internal/authority-consumer.ts";
const WORK_PLANE_PUBLIC_PATH = "packages/work-plane/src/index.ts";
const WORK_PLANE_CALLER_AUTHORITY_STATE_PATH = "packages/work-plane/src/internal/caller-authority-state.ts";
const WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH = "packages/work-plane/src/internal/caller-authority-owner.ts";
const FAMILY_EXECUTION_OWNER_PATH = "packages/work-plane/src/internal/family-execution-port.ts";
const FAMILY_RUNTIME_COMPOSITION_PATH = "generated/runtime-composition/index.ts";
const VALUATION_OWNER_RUNTIME_COMPOSITION_PATH = "generated/valuation-owner-registry/index.ts";
const RUNTIME_RELEASE_ECONOMIC_SAFETY_OWNER_PATH = "packages/runtime-release-authority/src/internal/economic-safety-owner.ts";
const RUNTIME_RELEASE_REVM_OWNER_PATH = "packages/runtime-release-authority/src/internal/revm-worker-owner.ts";
const RUNTIME_RELEASE_READY_BINDING_OWNER_PATH = "packages/runtime-release-authority/src/internal/ready-binding-owner.ts";
const RUNTIME_RELEASE_READY_BINDING_CONSUMER_PATH = "packages/runtime-release-authority/src/internal/ready-binding-consumer.ts";
const REVM_WORKER_PROTOCOL_PATH = "runtime/revm-workers/src/protocol.ts";
const REVM_WORKER_LIFECYCLE_PATH = "runtime/revm-workers/src/lifecycle.ts";
const REVM_WORKER_AUTHORITY_PATH = "runtime/revm-workers/src/internal/authority.ts";
const REVM_WORKER_RESOURCE_OBSERVATION_PATH = "runtime/revm-workers/src/internal/resource-observation.ts";
const PROCESS_RESOURCE_OBSERVER_PATH = "packages/process-resource-observer/src/index.ts";
const PROCESS_RESOURCE_SCOPE_OWNER_PATH = "packages/process-resource-observer/src/internal/scope-owner.ts";
const STARTUP_READY_OWNER_PATH = "packages/startup-runtime/src/internal/ready-owner.ts";
const STARTUP_RUNTIME_OWNER_PATH = "packages/startup-runtime/src/internal/runtime-owner.ts";
const STARTUP_SIX_STEP_ROUTE_PARENT_OWNER_PATH = "packages/startup-runtime/src/internal/six-step-route-parent-owner.ts";
const PRODUCTION_RELEASE_WORKFLOW_PATH = "tools/runtime-release-packager/src/production-workflow.ts";
const QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH = "tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts";
const CURRENT_CATALOG_IMPACT_OWNER_PATH = "tools/catalog-generator/src/current-impact-analysis-owner.ts";
const CURRENT_CATALOG_IMPACT_STATE_PATH = "tools/catalog-generator/src/internal/current-impact-analysis-state.ts";
const NOMINATION_QUALIFICATION_REUSE_PATH = "tools/runtime-release-packager/src/nomination-qualification-reuse.ts";
const NOMINATION_QUALIFICATION_REUSE_OWNER_PATH = "tools/runtime-release-packager/src/nomination-qualification-reuse-owner.ts";
const NOMINATION_QUALIFICATION_REUSE_STATE_PATH = "tools/runtime-release-packager/src/internal/nomination-qualification-reuse-owner-state.ts";
const RELEASE_PACKAGER_PUBLIC_ROOT_PATH = "tools/runtime-release-packager/src/index.ts";
const RELEASE_DEPLOYMENT_PACKAGE_PATH = "tools/runtime-release-packager/src/deployment-package.ts";
const FORBIDDEN_RELEASE_AUTHORING_PATHS = Object.freeze([
  "tools/runtime-release-packager/src/internal/assembled-release-acceptance-owner.ts",
  "tools/runtime-release-packager/src/internal/production-release-workflow-owner.ts",
  "tools/runtime-release-packager/src/internal/production-release-prepare-session-owner.ts",
  "tools/runtime-release-packager/src/internal/release-package-publication-fence-owner.ts",
  "tools/runtime-release-packager/src/publish-release-package.ts",
] as const);
const RELEASE_ASSEMBLED_ACCEPTANCE_PATH = "tools/runtime-release-packager/src/assembled-release-acceptance.ts";
const PRE_RELEASE_STAGING_PUBLIC_PATH = "tools/runtime-release-packager/src/pre-release-staging.ts";
const PRE_RELEASE_STAGING_OWNER_PATH = "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts";
const PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH = "tools/runtime-release-packager/src/internal/pre-release-runtime-receipt-state.ts";
const PRE_RELEASE_STAGING_SCHEMA_PATH = "tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts";
const PRE_RELEASE_AUTHORIZATION_LEDGER_PATH = "tools/runtime-release-packager/src/internal/pre-release-authorization-ledger.ts";
const PRE_RELEASE_FACT_LOG_PATH = "tools/pre-release-fact-log/src/index.ts";
const PRE_RELEASE_ACTIVE_READY_GRAPH_OBSERVER_PATH = "tools/runtime-release-packager/src/pre-release-b-active-ready-graph-observer.ts";
const PRE_RELEASE_ACTIVE_READY_GRAPH_OWNER_PATH = "tools/runtime-release-packager/src/internal/pre-release-b-active-ready-graph-owner.ts";
const PRE_RELEASE_ACTIVE_READY_GRAPH_OBSERVER_SPECIFIER = "../../runtime-release-packager/src/pre-release-b-active-ready-graph-observer.ts";
const PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_PATH = "tools/runtime-release-packager/src/pre-release-b-terminal-physical-observation.ts";
const PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_SPECIFIER = "../../runtime-release-packager/src/pre-release-b-terminal-physical-observation.ts";
const PRE_RELEASE_TERMINAL_PHYSICAL_STATE_PATH = "tools/runtime-release-packager/src/internal/pre-release-b-terminal-physical-observation-state.ts";
const PRE_RELEASE_TERMINAL_SNAPSHOT_OWNER_PATH = "tools/runtime-release-packager/src/internal/pre-release-b-terminal-snapshot-owner.ts";
const FINAL_PRE_RELEASE_FACT_LOG_SPECIFIER = "../../pre-release-fact-log/src/index.ts";
const PRE_RELEASE_LAUNCHER_PATH = "tools/runtime-release-packager/assets/pre-release-owner.mjs";
const PRODUCTION_LAUNCHER_PATH = "tools/runtime-release-packager/assets/production-launcher.mjs";
const RUNTIME_BUNDLE_BUILDER_PATH = "tools/runtime-release-packager/src/internal/runtime-bundle-builder.ts";
const RUNTIME_RELEASE_PERFORMANCE_POLICY_OWNER_PATH = "packages/runtime-release-authority/src/internal/performance-policy-owner.ts";
const COLLECTOR_PRODUCTION_CLOSURE_OBSERVER_PATH = "acceptance/collectors/src/production-closure-observer.ts";
const COLLECTOR_PRODUCTION_PERFORMANCE_OBSERVER_PATH = "acceptance/collectors/src/production-performance-material-observer.ts";
const COLLECTOR_PRODUCTION_TERMINAL_SELECTION_OBSERVER_PATH = "acceptance/collectors/src/production-terminal-selection-observer.ts";
const COLLECTOR_RUNTIME_BOUNDARY_OBSERVERS_PATH = "acceptance/collectors/src/production-runtime-boundary-observers.ts";
const COLLECTOR_PUBLIC_BARREL_PATH = "acceptance/collectors/src/index.ts";
const ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_PATH = "acceptance/collectors/src/production-artifact-lineage-observer.ts";
const ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH = "acceptance/collectors/src/internal/artifact-lineage-stage-one-owner.ts";
const ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH = "acceptance/collectors/src/internal/artifact-lineage-stage-one-state.ts";
const ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH = "acceptance/collectors/src/internal/artifact-lineage-stage-two-git-owner.ts";
const RELEASE_OWNED_OBSERVER_STORE_PATH = "acceptance/collectors/src/internal/release-owned-observer-store.ts";
const COLLECTOR_CONTENT_ADDRESSED_SINK_PATH = "acceptance/collectors/src/content-addressed-sink.ts";
const TERMINAL_PHASE_LOCATOR_INDEX_PATH = "acceptance/collectors/src/terminal-phase-locator-index.ts";
const PERFORMANCE_MATERIAL_OBSERVER_OWNER_PATH = "acceptance/collectors/src/internal/performance-material-observer-owner.ts";
const TERMINAL_SELECTION_MATERIAL_OWNER_PATH = "acceptance/collectors/src/internal/terminal-selection-material-owner.ts";
const RUNTIME_BOUNDARY_MATERIAL_OWNER_PATH = "acceptance/collectors/src/internal/runtime-boundary-material-owner.ts";
const RUNTIME_RELEASE_OBSERVER_STORE_OWNER_PATH = "packages/runtime-release-authority/src/internal/observer-store-owner.ts";
const ROOT_PREDICATE_MATERIAL_SOURCE_OWNER_PATH = "tools/runtime-release-packager/src/internal/root-predicate-material-source-owner.ts";
const SEARCHER_DEPLOYMENT_PATH = "apps/searcher-runtime/src/deployment.ts";
const SEARCHER_RUNTIME_PACKAGE_MANIFEST_PATH = "apps/searcher-runtime/package.json";
const SEARCHER_RELEASE_RUNTIME_PATH = "apps/searcher-runtime/src/release-runtime.ts";
const SEARCHER_RELEASE_RUNTIME_OWNER_PATH = "apps/searcher-runtime/src/release-runtime-owner.ts";
const SEARCHER_RELEASE_RUNTIME_PACKAGE_NAME = "@aloha/searcher-runtime";
const SEARCHER_RELEASE_RUNTIME_PACKAGE_SUBPATH = "./release-runtime";
const SEARCHER_RELEASE_RUNTIME_TSCONFIG_PATH = "apps/searcher-runtime/tsconfig.json";
const SEARCHER_RELEASE_RUNTIME_PACKAGE_ENTRYPOINT_ID = `package-entrypoint:${SEARCHER_RUNTIME_PACKAGE_MANIFEST_PATH}:${SEARCHER_RELEASE_RUNTIME_PACKAGE_SUBPATH}:${SEARCHER_RELEASE_RUNTIME_PATH}`;
const SEARCHER_RELEASE_RUNTIME_EXPORTS = Object.freeze([
  "issueInstalledProductionStartupCapabilityV1",
  "issuePreReleaseStartupCapabilityV1",
  "startReleaseRuntimeSessionV1",
] as const);
const SEARCHER_RUNTIME_ACCEPTANCE_EVIDENCE_PATH = "apps/searcher-runtime/src/runtime-acceptance-evidence.ts";
const FINAL_PRE_RELEASE_PACKAGE_NAME = "@aloha/runtime-release-packager";
const FINAL_PRE_RELEASE_PACKAGE_MANIFEST_PATH = "tools/runtime-release-packager/package.json";
const FINAL_PRE_RELEASE_PACKAGE_SUBPATH = "#bin:aloha-final-pre-release";
const FINAL_PRE_RELEASE_CLI_PATH = "tools/runtime-release-packager/src/final-pre-release-cli.ts";
const FINAL_PRE_RELEASE_RUNNER_PATH = "tools/runtime-release-packager/src/final-pre-release-runner.ts";
const PRE_RELEASE_B_QUALIFICATION_STATE_PATH = "tools/runtime-release-packager/src/internal/pre-release-b-qualification-state.ts";
const FINAL_PRE_RELEASE_TSCONFIG_PATH = "tools/runtime-release-packager/tsconfig.json";
const FINAL_PRE_RELEASE_PACKAGE_ENTRYPOINT_ID = `package-entrypoint:${FINAL_PRE_RELEASE_PACKAGE_MANIFEST_PATH}:${FINAL_PRE_RELEASE_PACKAGE_SUBPATH}:${FINAL_PRE_RELEASE_CLI_PATH}`;
const PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_NAME = "@aloha/pre-release-restart-controller";
const PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_MANIFEST_PATH = "tools/pre-release-restart-controller/package.json";
const PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_SUBPATH = "#bin:aloha-pre-release-restart-controller";
const PRE_RELEASE_RESTART_CONTROLLER_ENTRYPOINT_PATH = "tools/pre-release-restart-controller/src/cli.ts";
const PRE_RELEASE_RESTART_CONTROLLER_TSCONFIG_PATH = "tools/pre-release-restart-controller/tsconfig.json";
const PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_ENTRYPOINT_ID = `package-entrypoint:${PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_MANIFEST_PATH}:${PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_SUBPATH}:${PRE_RELEASE_RESTART_CONTROLLER_ENTRYPOINT_PATH}`;

function packageEntrypointCompilerIdentityV1(
  packageEntrypointId: string,
  configPath: string,
): string {
  return `${packageEntrypointId}:${configPath}`;
}

/** Exact terminal-phase capability paths.  This is one release composition
 * manifest, not a package-wide permission: each row fixes the importer,
 * resolved owner/consumer module, literal specifier and runtime named set. */
const TERMINAL_PHASE_AUTHORITY_IMPORTS = Object.freeze([
  { from: TERMINAL_PHASE_OBSERVATION_PORT_PUBLIC_PATH, to: TERMINAL_PHASE_OBSERVATION_PORT_OWNER_PATH, specifier: "./internal/owner.ts", named: ["assertIssuedProductionTerminalPhaseObservationPortV1"] },
  { from: TERMINAL_PHASE_COLLECTOR_PORT_PATH, to: TERMINAL_PHASE_OBSERVATION_PORT_OWNER_PATH, specifier: "../../../packages/terminal-phase-observation-port/src/internal/owner.ts", named: ["issueProductionTerminalPhaseObservationPortV1", "readProductionTerminalPhaseObservationResultV1"] },
  { from: TERMINAL_PHASE_COLLECTOR_PORT_PATH, to: FINAL_DURABLE_WINDOW_PUBLIC_PATH, specifier: "../../../packages/final-durable-window/src/index.ts", named: ["readFinalDurableWindowBindingV1"] },
  { from: TERMINAL_PHASE_COLLECTOR_PORT_PATH, to: RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH, specifier: "../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts", named: ["readRuntimeReleaseFullGraphCoarseSweepManifestV1"] },
  { from: TERMINAL_PHASE_COLLECTOR_PORT_PATH, to: FULL_FAMILY_COLLECTOR_PORT_PATH, specifier: "./production-full-family-port.ts", named: ["readProductionFullFamilyCollectorResultV1"] },
  { from: TERMINAL_PHASE_COLLECTOR_PORT_PATH, to: SIX_STEP_COLLECTOR_PORT_PATH, specifier: "./production-six-step-port.ts", named: ["readProductionSixStepCollectorResultV1"] },
  { from: SIX_STEP_OBSERVER_PATH, to: RUNTIME_RELEASE_SIX_STEP_TERMINAL_CONSUMER_PATH, specifier: "../../../packages/runtime-release-authority/src/six-step-terminal-consumer.ts", named: ["readRuntimeReleaseSixStepTerminalArtifactsV1", "readRuntimeReleaseSixStepTerminalBindingV1"] },
  { from: SIX_STEP_OBSERVER_PATH, to: EVIDENCE_EMITTER_PUBLIC_PATH, specifier: "../../../packages/evidence-emitter/src/index.ts", named: ["readProductionSixStepArtifactMaterialV1"] },
  { from: TERMINAL_PHASE_LOCATOR_INDEX_PATH, to: EVIDENCE_EMITTER_PUBLIC_PATH, specifier: "../../../packages/evidence-emitter/src/index.ts", named: ["decodeProductionSixStepArtifactMaterialV1"] },
  { from: SIX_STEP_OBSERVER_PATH, to: SIX_STEP_PROCESS_PUBLIC_PATH, specifier: "../../../packages/six-step-process-evidence/src/index.ts", named: ["readSearcherProductionSixStepProcessEvidenceV1", "readSearcherProductionSixStepWindowSelectionV1"] },
  { from: SIX_STEP_PROCESS_PUBLIC_PATH, to: SIX_STEP_COMPLETE_APPEND_OWNER_PATH, specifier: "./internal/complete-append-owner.ts", named: ["readSearcherProductionSixStepCompleteAppendMaterialV1"] },
  { from: SIX_STEP_PROCESS_PUBLIC_PATH, to: SIX_STEP_WINDOW_SELECTION_OWNER_PATH, specifier: "./internal/window-selection-owner.ts", named: ["SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST", "readSearcherProductionSixStepWindowSelectionCapabilityV1"] },
  { from: SIX_STEP_WINDOW_SELECTION_OWNER_PATH, to: FINAL_DURABLE_WINDOW_PUBLIC_PATH, specifier: "../../../final-durable-window/src/index.ts", named: ["readFinalDurableWindowBindingV1"] },
  { from: SIX_STEP_WINDOW_SELECTION_OWNER_PATH, to: SIX_STEP_COMPLETE_APPEND_OWNER_PATH, specifier: "./complete-append-owner.ts", named: ["readSearcherProductionSixStepCompleteAppendMaterialV1"] },
  { from: SEARCHER_PRODUCTION_EVIDENCE_PATH, to: SIX_STEP_COMPLETE_APPEND_OWNER_PATH, specifier: "../../../packages/six-step-process-evidence/src/internal/complete-append-owner.ts", named: ["issueSearcherProductionSixStepCompleteAppendCapabilityV1", "issueSearcherProductionSixStepPerformanceAppendCapabilityV1", "readSearcherProductionSixStepCompleteAppendMaterialV1"] },
  { from: SEARCHER_PRODUCTION_EVIDENCE_PATH, to: SIX_STEP_WINDOW_SELECTION_OWNER_PATH, specifier: "../../../packages/six-step-process-evidence/src/internal/window-selection-owner.ts", named: ["issueSearcherProductionSixStepWindowSelectionV1"] },
  { from: SEARCHER_PRODUCTION_EVIDENCE_PATH, to: FINAL_DURABLE_WINDOW_PUBLIC_PATH, specifier: "../../../packages/final-durable-window/src/index.ts", named: ["decodeTerminalPhaseInvalidFactV1", "readFinalDurableWindowBindingV1"] },
  { from: SEARCHER_PRODUCTION_EVIDENCE_PATH, to: FINAL_DURABLE_WINDOW_OWNER_PATH, specifier: "../../../packages/final-durable-window/src/internal/owner.ts", named: ["createTerminalPhaseHeadObservationV1", "createTerminalPhaseInvalidFactV1", "issueFinalDurableWindowCapabilityV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH, specifier: "../../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts", named: ["assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: RUNTIME_RELEASE_SIX_STEP_TERMINAL_CONSUMER_PATH, specifier: "../../../../packages/runtime-release-authority/src/six-step-terminal-consumer.ts", named: ["assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: FULL_FAMILY_OBSERVATION_PORT_PUBLIC_PATH, specifier: "../../../../packages/full-family-observation-port/src/index.ts", named: ["assertIssuedProductionFullFamilyObservationPortV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: SIX_STEP_OBSERVATION_PORT_PUBLIC_PATH, specifier: "../../../../packages/six-step-observation-port/src/index.ts", named: ["assertIssuedProductionSixStepObservationPortV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: TERMINAL_PHASE_OBSERVATION_PORT_PUBLIC_PATH, specifier: "../../../../packages/terminal-phase-observation-port/src/index.ts", named: ["assertIssuedProductionTerminalPhaseObservationPortV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: SIX_STEP_PROCESS_PUBLIC_PATH, specifier: "../../../../packages/six-step-process-evidence/src/index.ts", named: ["readSearcherProductionSixStepCompleteAppendSearchTerminalV1", "readSearcherProductionSixStepWindowSelectionV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: SIX_STEP_PROCESS_OWNER_PATH, specifier: "../../../../packages/six-step-process-evidence/src/internal/owner.ts", named: ["issueSearcherProductionSixStepProcessEvidenceV1"] },
  { from: SEARCHER_APPLICATION_OWNER_PATH, to: STARTUP_RUNTIME_PUBLIC_PATH, specifier: "../../../../packages/startup-runtime/src/index.ts", named: ["assertIssuedStartupRuntime", "readStartupFullFamilyEvidenceBinding"] },
  { from: RUNTIME_RELEASE_BOOTSTRAP_PATH, to: RUNTIME_RELEASE_SIX_STEP_TERMINAL_OWNER_PATH, specifier: "./six-step-terminal-owner.ts", named: ["issueRuntimeReleaseSixStepTerminalBindingServiceV1"] },
  { from: RUNTIME_RELEASE_BOOTSTRAP_PATH, to: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, specifier: "./six-step-production-owner.ts", named: ["issueRuntimeReleaseSixStepProductionV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, to: EVIDENCE_EMITTER_SIX_STEP_PRODUCTION_OWNER_PATH, specifier: "../../../evidence-emitter/src/internal/six-step-production-owner.ts", named: ["ProductionSixStepArtifactOwnerV1", "issueProductionSixStepArtifactStoreV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, to: EVIDENCE_EMITTER_PUBLIC_PATH, specifier: "../../../evidence-emitter/src/index.ts", named: ["productionSixStepBoundaryKeyV1", "readProductionSixStepArtifactMaterialV1", "readProductionSixStepWitnessV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, to: CHECKPOINT_PUBLIC_PATH, specifier: "../../../checkpoint/src/index.ts", named: [] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, to: CHECKPOINT_SIX_STEP_ARTIFACT_PORT_OWNER_PATH, specifier: "../../../checkpoint/src/internal/six-step-artifact-port-owner.ts", named: ["issueCheckpointSixStepArtifactPortV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, to: SEARCH_PIPELINE_PUBLIC_PATH, specifier: "../../../search-pipeline/src/index.ts", named: [] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, to: SEARCH_PIPELINE_SIX_STEP_TAIL_PORT_OWNER_PATH, specifier: "../../../search-pipeline/src/internal/six-step-tail-port-owner.ts", named: ["issueProductionSixStepTailEmissionPortV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, to: STARTUP_SIX_STEP_ROUTE_PARENT_OWNER_PATH, specifier: "../../../startup-runtime/src/internal/six-step-route-parent-owner.ts", named: ["issueStartupSixStepRouteParentInvocationV1", "readStartupSixStepRouteParentInvocationMaterialV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_CONSUMER_PATH, to: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH, specifier: "./internal/six-step-production-owner.ts", named: ["readRuntimeReleaseSixStepTailEmissionPortV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_PRODUCTION_CONSUMER_PATH, to: RUNTIME_RELEASE_STRATEGY_OWNER_PATH, specifier: "./internal/strategy-runtime-owner.ts", named: ["assertIssuedRuntimeReleaseStrategyRuntimeService"] },
  { from: STARTUP_RUNTIME_PUBLIC_PATH, to: STARTUP_SIX_STEP_ROUTE_PARENT_OWNER_PATH, specifier: "./internal/six-step-route-parent-owner.ts", named: ["issueStartupSixStepRouteParentCapabilityV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_TERMINAL_CONSUMER_PATH, to: RUNTIME_RELEASE_SIX_STEP_TERMINAL_OWNER_PATH, specifier: "./internal/six-step-terminal-owner.ts", named: ["assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1", "readRuntimeReleaseSixStepTerminalArtifactCapabilitiesV1", "readRuntimeReleaseSixStepTerminalBindingCapabilityV1"] },
  { from: RUNTIME_RELEASE_SIX_STEP_TERMINAL_OWNER_PATH, to: RUNTIME_RELEASE_STATE_PATH, specifier: "./state.ts", named: ["assertActiveRuntimeReleaseAuthorityState"] },
  { from: RUNTIME_RELEASE_SIX_STEP_TERMINAL_OWNER_PATH, to: "packages/search-pipeline/src/index.ts", specifier: "../../../../packages/search-pipeline/src/index.ts", named: ["readIssuedSearchTerminalCapabilityV1", "readIssuedSearchTerminalSixStepArtifactCapabilitiesV1", "readIssuedSearchTerminalSixStepTraceV1", "searchTerminalEvidenceHashV2"] },
  { from: RUNTIME_RELEASE_SIX_STEP_TERMINAL_OWNER_PATH, to: RUNTIME_RELEASE_STRATEGY_OWNER_PATH, specifier: "./strategy-runtime-owner.ts", named: ["assertIssuedRuntimeReleaseStrategyRuntimeService"] },
] as const);

const TERMINAL_PHASE_INTERNAL_OWNER_EDGES = new Set(TERMINAL_PHASE_AUTHORITY_IMPORTS
  .filter((edge) => edge.to.includes("/src/internal/"))
  .map((edge) => `${edge.from}\u2192${edge.to}`));

/** The physical collector and the exact-commit runner each mint a local
 * PredicateMaterialSource capability against the same process-local state
 * registry.  This manifest fixes every importer and prevents an unrelated
 * collector/tool from acquiring either minting path. */
const PREDICATE_MATERIAL_SOURCE_AUTHORITY_IMPORTS = Object.freeze([
  { from: COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_ISSUER_PATH, specifier: "./internal/predicate-material-source-issuer.ts", named: ["issueProductionPredicateMaterialSourcePortV1"] },
  { from: ROOT_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH, specifier: "../../../../acceptance/collectors/src/production-predicate-material-source.ts", named: ["issueProductionPredicateMaterialSourceV1"] },
  { from: COLLECTOR_PREDICATE_MATERIAL_PUBLIC_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "./internal/predicate-material-source-owner.ts", named: ["assertProductionPredicateMaterialSourcePortV1"] },
  { from: COLLECTOR_PREDICATE_MATERIAL_SOURCE_ISSUER_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "./predicate-material-source-owner.ts", named: ["registerProductionPredicateMaterialSourceStateV1"] },
  { from: COLLECTOR_PREDICATE_MATERIAL_BRIDGE_ISSUER_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "./predicate-material-source-owner.ts", named: ["registerProductionPredicateMaterialSourceStateV1"] },
  { from: FRESH_QUALIFIED_RUNNER_HOST_OWNER_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../../../../acceptance/collectors/src/internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../../../acceptance/collectors/src/internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
  { from: QUALIFIED_RELEASE_RUNTIME_ENTRY_PATH, to: COLLECTOR_PREDICATE_MATERIAL_BRIDGE_ISSUER_PATH, specifier: "../../../../acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts", named: ["issueBridgedPredicateMaterialSourcePortV1"] },
  { from: COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH, to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../internal/predicate-material-source-owner.ts", named: ["assertProductionPredicateMaterialSourcePortV1"] },
  { from: "acceptance/collectors/src/material-providers/runtime-boundaries.ts", to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
  { from: "acceptance/collectors/src/material-providers/terminal-selection.ts", to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
  { from: "acceptance/collectors/src/material-providers/artifact-lineage.ts", to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
  { from: "acceptance/collectors/src/material-providers/performance.ts", to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
  { from: "acceptance/collectors/src/material-providers/six-step.ts", to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
  { from: "acceptance/collectors/src/material-providers/full-family.ts", to: COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "../internal/predicate-material-source-owner.ts", named: ["readProductionPredicateMaterialSourceStateV1"] },
] as const);

const PREDICATE_MATERIAL_SOURCE_OWNER_EDGES = new Set(PREDICATE_MATERIAL_SOURCE_AUTHORITY_IMPORTS
  .map((edge) => `${edge.from}\u2192${edge.to}`));

const PRODUCTION_RELEASE_ADVISORY_AUTHORITY_IMPORTS = Object.freeze([
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, specifier: "./internal/qualified-release-public-runner-state.ts", named: ["observeQualifiedReleaseAcceptanceAdvisoryV1", "readQualifiedReleaseLineageObservationV1"] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: COLLECTOR_RUNTIME_BOUNDARY_OBSERVERS_PATH, specifier: "../../../acceptance/collectors/src/production-runtime-boundary-observers.ts", named: ["issueProductionClosureMaterialObserverPortsV1"] },
  { from: COLLECTOR_PRODUCTION_CLOSURE_OBSERVER_PATH, to: RELEASE_ASSEMBLED_ACCEPTANCE_PATH, specifier: "../../../tools/runtime-release-packager/src/assembled-release-acceptance.ts", named: ["readQualifiedReleaseLineageObservationV1"] },
  { from: COLLECTOR_RUNTIME_BOUNDARY_OBSERVERS_PATH, to: RELEASE_ASSEMBLED_ACCEPTANCE_PATH, specifier: "../../../tools/runtime-release-packager/src/assembled-release-acceptance.ts", named: [] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: ROOT_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, specifier: "./internal/root-predicate-material-source-owner.ts", named: ["issueRootPredicateMaterialSourceV1"] },
  { from: RUNTIME_RELEASE_BOOTSTRAP_PATH, to: RUNTIME_RELEASE_OBSERVER_STORE_OWNER_PATH, specifier: "./observer-store-owner.ts", named: ["issueRuntimeReleaseObserverStoreServiceV1"] },
] as const);

/** Receipt, Stage 2, and release-binding authority are deliberately narrower
 * than the surrounding authoring/collector packages. Every runtime reader or
 * registrar is bound to one exact importer and literal module specifier. */
const PRE_RELEASE_BOUNDARY_AUTHORITY_IMPORTS = Object.freeze([
  { from: PRE_RELEASE_STAGING_OWNER_PATH, to: RELEASE_ASSEMBLED_ACCEPTANCE_PATH, specifier: "../assembled-release-acceptance.ts", named: ["installQualifiedReleaseAcceptanceRunnerV1", "readAuthorizedQualifiedReleaseRunnerWireV1", "readQualifiedReleaseLineageObservationV1"] },
  { from: RELEASE_ASSEMBLED_ACCEPTANCE_PATH, to: QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, specifier: "./internal/qualified-release-public-runner-state.ts", named: ["observeQualifiedReleaseAcceptanceAdvisoryV1", "readAuthorizedQualifiedReleaseRunnerWireV1", "readQualifiedReleaseLineageObservationV1", "registerPublicQualifiedReleaseRunnerV1"] },
  { from: COLLECTOR_PRODUCTION_CLOSURE_OBSERVER_PATH, to: QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, specifier: "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts", named: ["readQualifiedReleaseLineageObservationV1"] },
  { from: COLLECTOR_PRODUCTION_PERFORMANCE_OBSERVER_PATH, to: QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, specifier: "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts", named: ["readQualifiedReleaseLineageObservationV1"] },
  { from: COLLECTOR_PRODUCTION_TERMINAL_SELECTION_OBSERVER_PATH, to: QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, specifier: "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts", named: ["readQualifiedReleaseLineageObservationV1"] },
  { from: COLLECTOR_RUNTIME_BOUNDARY_OBSERVERS_PATH, to: QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, specifier: "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts", named: ["readQualifiedReleaseLineageObservationV1"] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH, specifier: "./internal/pre-release-runtime-receipt-state.ts", named: ["readPreReleaseAdvisoryMaterialV1"] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: PRE_RELEASE_STAGING_PUBLIC_PATH, specifier: "./pre-release-staging.ts", named: ["readPreReleaseAdvisoryMaterialCapabilityV1"] },
  { from: COLLECTOR_PRODUCTION_CLOSURE_OBSERVER_PATH, to: PRE_RELEASE_STAGING_PUBLIC_PATH, specifier: "../../../tools/runtime-release-packager/src/pre-release-staging.ts", named: ["readPreReleaseAdvisoryMaterialCapabilityV1"] },
  { from: COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH, to: ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH, specifier: "./internal/artifact-lineage-stage-two-git-owner.ts", named: ["observeArtifactLineageStageTwoGitEvidenceV1"] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: PERFORMANCE_MATERIAL_OBSERVER_OWNER_PATH, specifier: "../../../acceptance/collectors/src/internal/performance-material-observer-owner.ts", named: ["readProductionPerformanceMaterialObserverReleaseBindingV1"] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: TERMINAL_SELECTION_MATERIAL_OWNER_PATH, specifier: "../../../acceptance/collectors/src/internal/terminal-selection-material-owner.ts", named: ["readProductionTerminalSelectionObserverReleaseBindingV1"] },
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: RUNTIME_BOUNDARY_MATERIAL_OWNER_PATH, specifier: "../../../acceptance/collectors/src/internal/runtime-boundary-material-owner.ts", named: ["readProductionRuntimeRestartMaterialObserverReleaseBindingV1"] },
  { from: FINAL_PRE_RELEASE_RUNNER_PATH, to: PRE_RELEASE_AUTHORIZATION_LEDGER_PATH, specifier: "./internal/pre-release-authorization-ledger.ts", named: ["claimFixedPreReleaseAuthorizationV1", "readFixedPreReleaseAuthorizationClaimV1"] },
  { from: FINAL_PRE_RELEASE_RUNNER_PATH, to: SEARCHER_RUNTIME_ACCEPTANCE_EVIDENCE_PATH, specifier: "../../../apps/searcher-runtime/src/runtime-acceptance-evidence.ts", named: ["sealPreReleaseRestartTerminalV1"] },
  { from: SEARCHER_RUNTIME_ACCEPTANCE_EVIDENCE_PATH, to: PRE_RELEASE_AUTHORIZATION_LEDGER_PATH, specifier: "../../../tools/runtime-release-packager/src/internal/pre-release-authorization-ledger.ts", named: ["readFixedPreReleaseAuthorizationClaimV1"] },
  { from: FINAL_PRE_RELEASE_RUNNER_PATH, to: PRE_RELEASE_B_QUALIFICATION_STATE_PATH, specifier: "./internal/pre-release-b-qualification-state.ts", named: ["issueFrozenPreReleaseBQualificationCapabilityV1"] },
  { from: FINAL_PRE_RELEASE_RUNNER_PATH, to: PRE_RELEASE_STAGING_OWNER_PATH, specifier: "./internal/pre-release-staging-owner.ts", named: ["importFrozenPreReleaseBRuntimeV1", "issueImportedFrozenPreReleaseBAdvisoryMaterialV1", "readImportedFrozenPreReleaseBTerminalPhysicalObservationV1"] },
  { from: PRE_RELEASE_STAGING_OWNER_PATH, to: PRE_RELEASE_B_QUALIFICATION_STATE_PATH, specifier: "./pre-release-b-qualification-state.ts", named: ["readFrozenPreReleaseBQualificationCapabilityV1"] },
  { from: PRE_RELEASE_TERMINAL_SNAPSHOT_OWNER_PATH, to: PRE_RELEASE_TERMINAL_PHYSICAL_STATE_PATH, specifier: "./pre-release-b-terminal-physical-observation-state.ts", named: ["registerPreReleaseBTerminalPhysicalObservationV1"] },
  { from: PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_PATH, to: PRE_RELEASE_TERMINAL_PHYSICAL_STATE_PATH, specifier: "./internal/pre-release-b-terminal-physical-observation-state.ts", named: ["readRegisteredPreReleaseBTerminalPhysicalObservationV1"] },
] as const);

const PRODUCTION_RELEASE_ADVISORY_OWNER_EDGES = new Set(PRODUCTION_RELEASE_ADVISORY_AUTHORITY_IMPORTS
  .map((edge) => `${edge.from}\u2192${edge.to}`));

const PRE_RELEASE_BOUNDARY_OWNER_EDGES = new Set(PRE_RELEASE_BOUNDARY_AUTHORITY_IMPORTS
  .map((edge) => `${edge.from}\u2192${edge.to}`));
PRE_RELEASE_BOUNDARY_OWNER_EDGES.add(`${PRE_RELEASE_STAGING_PUBLIC_PATH}\u2192${PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH}`);

const CATALOG_NOMINATION_REUSE_AUTHORITY_IMPORTS = Object.freeze([
  { from: CURRENT_CATALOG_IMPACT_OWNER_PATH, to: CURRENT_CATALOG_IMPACT_STATE_PATH, specifier: "./internal/current-impact-analysis-state.ts", named: ["registerCurrentCatalogImpactAnalysisCapabilityV1"] },
  { from: NOMINATION_QUALIFICATION_REUSE_PATH, to: CURRENT_CATALOG_IMPACT_STATE_PATH, specifier: "../../catalog-generator/src/internal/current-impact-analysis-state.ts", named: ["readCurrentCatalogImpactAnalysisCapabilityV1"] },
  { from: NOMINATION_QUALIFICATION_REUSE_PATH, to: NOMINATION_QUALIFICATION_REUSE_STATE_PATH, specifier: "./internal/nomination-qualification-reuse-owner-state.ts", named: ["readNominationQualificationReuseOwnerCompositionV1"] },
  { from: NOMINATION_QUALIFICATION_REUSE_OWNER_PATH, to: NOMINATION_QUALIFICATION_REUSE_STATE_PATH, specifier: "./internal/nomination-qualification-reuse-owner-state.ts", named: ["readNominationQualificationReuseOwnerCompositionV1", "registerNominationQualificationReuseOwnerCompositionV1"] },
  { from: NOMINATION_QUALIFICATION_REUSE_OWNER_PATH, to: PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH, specifier: "./internal/pre-release-runtime-receipt-state.ts", named: ["readPreReleaseAdvisoryMaterialV1"] },
  { from: NOMINATION_QUALIFICATION_REUSE_OWNER_PATH, to: QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, specifier: "./internal/qualified-release-public-runner-state.ts", named: ["readAuthorizedQualifiedReleaseRunnerWireV1"] },
] as const);

const CATALOG_NOMINATION_REUSE_OWNER_EDGES = new Set(CATALOG_NOMINATION_REUSE_AUTHORITY_IMPORTS
  .map((edge) => `${edge.from}\u2192${edge.to}`));

const PRE_RELEASE_SCHEMA_RESTRICTED_RUNTIME_EXPORTS = new Set([
  "PRE_RELEASE_SYSTEMD_UNIT_V1",
  "assertCanonicalPreReleaseSystemdUnitV1",
  "PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1",
  "PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1",
  "PRE_RELEASE_STAGING_LAYOUT_V1",
  "decodePreReleaseLaunchAuthorizationV1",
  "decodePreReleaseStagingManifestV1",
  "hashPreReleaseStagingArtifactSetV1",
  "preReleaseStagingArtifactPathV1",
  "verifyPreReleaseLaunchAuthorizationSignatureV1",
]);

const PRE_RELEASE_SCHEMA_AUTHORITY_IMPORTS = Object.freeze([
  { from: PRODUCTION_RELEASE_WORKFLOW_PATH, to: PRE_RELEASE_STAGING_SCHEMA_PATH, specifier: "./internal/pre-release-staging-schema.ts", imported: ["PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1", "PRE_RELEASE_STAGING_LAYOUT_V1", "preReleaseStagingArtifactPathV1"], exported: [] },
  { from: PRE_RELEASE_STAGING_OWNER_PATH, to: PRE_RELEASE_STAGING_SCHEMA_PATH, specifier: "./pre-release-staging-schema.ts", imported: ["PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1", "PRE_RELEASE_STAGING_LAYOUT_V1"], exported: ["PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1", "PRE_RELEASE_STAGING_LAYOUT_V1", "verifyPreReleaseLaunchAuthorizationSignatureV1"] },
  { from: PRE_RELEASE_AUTHORIZATION_LEDGER_PATH, to: PRE_RELEASE_STAGING_SCHEMA_PATH, specifier: "./pre-release-staging-schema.ts", imported: ["PRE_RELEASE_STAGING_LAYOUT_V1", "decodePreReleaseLaunchAuthorizationV1"], exported: [] },
  { from: FINAL_PRE_RELEASE_RUNNER_PATH, to: PRE_RELEASE_STAGING_SCHEMA_PATH, specifier: "./internal/pre-release-staging-schema.ts", imported: ["PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1", "PRE_RELEASE_STAGING_LAYOUT_V1", "decodePreReleaseLaunchAuthorizationV1", "decodePreReleaseStagingManifestV1", "hashPreReleaseStagingArtifactSetV1", "preReleaseStagingArtifactPathV1", "verifyPreReleaseLaunchAuthorizationSignatureV1"], exported: [] },
  { from: SEARCHER_RUNTIME_ACCEPTANCE_EVIDENCE_PATH, to: PRE_RELEASE_STAGING_SCHEMA_PATH, specifier: "../../../tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts", imported: ["PRE_RELEASE_STAGING_LAYOUT_V1", "decodePreReleaseLaunchAuthorizationV1", "decodePreReleaseStagingManifestV1"], exported: [] },
  { from: COLLECTOR_PRODUCTION_CLOSURE_OBSERVER_PATH, to: PRE_RELEASE_STAGING_SCHEMA_PATH, specifier: "../../../tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts", imported: ["PRE_RELEASE_SYSTEMD_UNIT_V1", "decodePreReleaseLaunchAuthorizationV1", "decodePreReleaseStagingManifestV1", "hashPreReleaseStagingArtifactSetV1"], exported: [] },
] as const);
for (const edge of PRE_RELEASE_SCHEMA_AUTHORITY_IMPORTS) {
  PRE_RELEASE_BOUNDARY_OWNER_EDGES.add(`${edge.from}\u2192${edge.to}`);
}

const PRE_RELEASE_RESTRICTED_RUNTIME_EXPORTS = new Map<string, ReadonlySet<string>>([
  [PRE_RELEASE_TERMINAL_PHYSICAL_STATE_PATH, new Set([
    "readRegisteredPreReleaseBTerminalPhysicalObservationV1",
    "registerPreReleaseBTerminalPhysicalObservationV1",
  ])],
  [PRE_RELEASE_STAGING_OWNER_PATH, new Set([
    "completePreReleaseRuntimeLaunchV1",
    "importFrozenPreReleaseBRuntimeV1",
    "importPreReleaseRuntimeBundleV1",
    "installPreReleaseQualifiedReleaseRunnerV1",
    "issueImportedFrozenPreReleaseBAdvisoryMaterialV1",
    "issuePreReleaseLaunchCapabilityV1",
    "readImportedFrozenPreReleaseBTerminalPhysicalObservationV1",
    "readImportedFrozenPreReleaseBRuntimeV1",
    "readPreReleaseQualifiedRunnerInputBytesV1",
  ])],
  [QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, new Set([
    "installVerifiedQualifiedReleaseRunnerWireV1",
    "readAuthorizedQualifiedReleaseRunnerWireV1",
    "readPublicQualifiedReleaseRunnerStateV1",
    "readQualifiedReleaseLineageObservationV1",
    "readVerifiedAuthorizedQualifiedRunnerWireLineageV1",
    "registerPublicQualifiedReleaseRunnerV1",
    "observeQualifiedReleaseAcceptanceAdvisoryV1",
    "verifyAuthorizedQualifiedReleaseRunnerWireV1",
  ])],
  [RUNTIME_RELEASE_PERFORMANCE_POLICY_OWNER_PATH, new Set([
    "issuePreReleaseRuntimeReleasePerformancePolicyPortV1",
  ])],
  [PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH, new Set([
    "issuePreReleaseAdvisoryMaterialCapabilityV1",
    "readPreReleaseAdvisoryMaterialCapabilityV1",
    "readPreReleaseAdvisoryMaterialV1",
  ])],
  [PRE_RELEASE_AUTHORIZATION_LEDGER_PATH, new Set([
    "claimFixedPreReleaseAuthorizationV1",
    "claimPreReleaseAuthorizationInDatabaseV1",
    "readFixedPreReleaseAuthorizationClaimV1",
  ])],
  [PRE_RELEASE_B_QUALIFICATION_STATE_PATH, new Set([
    "issueFrozenPreReleaseBQualificationCapabilityV1",
    "readFrozenPreReleaseBQualificationCapabilityV1",
  ])],
  [SEARCHER_RUNTIME_ACCEPTANCE_EVIDENCE_PATH, new Set([
    "resolvePreReleaseRestartPredecessorV1",
    "sealPreReleaseRestartTerminalV1",
  ])],
  [PRE_RELEASE_STAGING_PUBLIC_PATH, new Set(["readPreReleaseAdvisoryMaterialCapabilityV1"])],
  [ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH, new Set(["observeArtifactLineageStageTwoGitEvidenceV1"])],
  [ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH, new Set(["readArtifactLineageStageTwoAuthorityV1"])],
  [PERFORMANCE_MATERIAL_OBSERVER_OWNER_PATH, new Set([
    "readObservedProductionPerformanceDeploymentMaterialV1",
    "readProductionPerformanceMaterialObserverReleaseBindingV1",
  ])],
  [TERMINAL_SELECTION_MATERIAL_OWNER_PATH, new Set(["readProductionTerminalSelectionObserverReleaseBindingV1"])],
  [RUNTIME_BOUNDARY_MATERIAL_OWNER_PATH, new Set(["readProductionRuntimeRestartMaterialObserverReleaseBindingV1"])],
  [PRE_RELEASE_STAGING_SCHEMA_PATH, new Set([
    ...PRE_RELEASE_SCHEMA_RESTRICTED_RUNTIME_EXPORTS,
  ])],
]);

const ARTIFACT_LINEAGE_STAGE_ONE_AUTHORITY_IMPORTS = Object.freeze([
  { from: ROOT_PREDICATE_MATERIAL_SOURCE_OWNER_PATH, to: ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH, specifier: "../../../../acceptance/collectors/src/internal/artifact-lineage-stage-one-owner.ts", named: ["issueProductionArtifactLineageStageOneObserverPortV1"] },
  { from: RUNTIME_RELEASE_OBSERVER_STORE_OWNER_PATH, to: RELEASE_OWNED_OBSERVER_STORE_PATH, specifier: "../../../../acceptance/collectors/src/internal/release-owned-observer-store.ts", named: ["issueReleaseOwnedObserverStoreV1", "readReleaseOwnedObserverStoreV1"] },
  { from: ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH, to: ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH, specifier: "./artifact-lineage-stage-one-state.ts", named: ["registerArtifactLineageStageOneCapabilityV1", "registerArtifactLineageStageOneObserverPortV1"] },
  { from: ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH, to: RELEASE_OWNED_OBSERVER_STORE_PATH, specifier: "./release-owned-observer-store.ts", named: ["readReleaseOwnedObserverStoreV1"] },
  { from: ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH, to: RELEASE_OWNED_OBSERVER_STORE_PATH, specifier: "./release-owned-observer-store.ts", named: ["readReleaseOwnedObserverStoreV1"] },
  { from: RELEASE_OWNED_OBSERVER_STORE_PATH, to: COLLECTOR_CONTENT_ADDRESSED_SINK_PATH, specifier: "../content-addressed-sink.ts", named: ["ContentAddressedObserverSinkV1"] },
  { from: COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH, to: ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_PATH, specifier: "./production-artifact-lineage-observer.ts", named: ["readArtifactLineageStageOneCapabilityV1"] },
  { from: COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH, to: ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH, specifier: "./internal/artifact-lineage-stage-one-state.ts", named: ["assertArtifactLineageStageOneObserverStoreV1", "readArtifactLineageStageTwoAuthorityV1"] },
  { from: COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH, to: RELEASE_OWNED_OBSERVER_STORE_PATH, specifier: "./internal/release-owned-observer-store.ts", named: ["readReleaseOwnedObserverStoreV1"] },
  { from: COLLECTOR_RUNTIME_BOUNDARY_OBSERVERS_PATH, to: RELEASE_OWNED_OBSERVER_STORE_PATH, specifier: "./internal/release-owned-observer-store.ts", named: ["readReleaseOwnedObserverStoreV1"] },
] as const);

const ARTIFACT_LINEAGE_STAGE_ONE_OWNER_EDGES = new Set([
  ...ARTIFACT_LINEAGE_STAGE_ONE_AUTHORITY_IMPORTS.map(edge => `${edge.from}\u2192${edge.to}`),
  `${ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_PATH}\u2192${ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH}`,
]);

const SEARCH_PIPELINE_ROUTE_PATH = "packages/search-pipeline/src/route-pipeline.ts";
const COARSE_SEARCH_OWNER_PATH = "packages/coarse-economics/src/internal/search-owner.ts";
const SEARCH_RUNTIME_CORE_PATH = "packages/search-runtime-core/src/index.ts";
const COARSE_ATTEMPT_EVIDENCE_OWNER_PATH = "packages/search-pipeline/src/internal/coarse-attempt-evidence-owner.ts";
const COARSE_ATTEMPT_EVIDENCE_STATE_PATH = "packages/search-pipeline/src/internal/coarse-attempt-evidence-state.ts";
const FAMILY_COMPOSITION_PUBLIC_PATH = "packages/family-composition/src/index.ts";
const COARSE_FULL_GRAPH_SWEEP_OWNER_PATH = "packages/coarse-economics/src/internal/full-graph-sweep-owner.ts";
const FULL_GRAPH_COARSE_SWEEP_OWNER_PATH = "packages/full-graph-coarse-sweep/src/internal/sweep-owner.ts";
const FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH = "packages/full-graph-coarse-sweep/src/internal/invocation-owner.ts";
const FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH = "packages/full-graph-coarse-sweep/src/internal/source-read-owner.ts";
const SEARCHER_RETH_SOURCE_PATH = "apps/searcher-runtime/src/internal/reth-source.ts";
const STRATEGY_COMPOSITION_PUBLIC_PATH = "packages/strategy-composition/src/index.ts";
const STRATEGY_GENERATED_RUNTIME_PATH = "packages/strategy-composition/src/internal/generated-runtime-composition.ts";
const STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH = "packages/strategy-composition/src/internal/runtime-composition-authority.ts";
const STRATEGY_TRIGGER_OWNER_PATH = "packages/strategy-composition/src/internal/trigger-owner.ts";
const CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH = "packages/checkpoint/src/internal/ready-stage12-evidence-state.ts";
const CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH = "packages/checkpoint/src/internal/ready-stage12-evidence-issuer.ts";
const CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH = "packages/checkpoint/src/internal/ready-stage12-evidence-consumer.ts";
const CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH = "packages/checkpoint/src/internal/ready-full-family-evidence-state.ts";
const CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH = "packages/checkpoint/src/internal/ready-full-family-evidence-issuer.ts";
const CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH = "packages/checkpoint/src/internal/ready-full-family-evidence-consumer.ts";
const CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH = "packages/checkpoint/src/ready-full-family-evidence-consumer.ts";
const RELEASE_AUTHORITY_SPEC_PATH = "specs/release-authority/src/index.ts";
const ATTESTATION_PUBLIC_CONTRACT_PATH = "packages/attestation/src/index.ts";
const ATTESTATION_ENGINE_PATH = "packages/attestation/src/internal/engine.ts";
const RELEASE_LEDGER_PATH = "acceptance/gate-core/src/release-role-manifest.ledger.json";
const EXTERNAL_DEPLOYMENT_LOADER_PATH = "apps/searcher-runtime/src/cli.ts";
const RELEASE_GENERATOR_CLI_PATH = "tools/release-role-manifest/src/cli.ts";
const RELEASE_GENERATOR_INDEX_PATH = "tools/release-role-manifest/src/index.ts";
const RELEASE_GENERATED_OUTPUT_PATHS = Object.freeze([
  "acceptance/gate-core/src/generated/predicate-composition.ts",
  "acceptance/gate-core/src/generated/release-role-manifest.ts",
  RELEASE_RUNTIME_PATH,
].sort());
const RELEASE_FIXED_OUTPUT_PATHS = Object.freeze([RELEASE_AUTHORITY_PATH].sort());
const RELEASE_OUTPUT_PATHS = Object.freeze([...RELEASE_GENERATED_OUTPUT_PATHS, ...RELEASE_FIXED_OUTPUT_PATHS].sort());
const CATALOG_LEDGER_PATH = "generated/catalog-generation.ledger.json";
const CATALOG_INPUT_PATH = "generated/catalog-generation.inputs.json";
const CATALOG_TSCONFIG_PATH = "generated/tsconfig.json";
const CATALOG_GENERATOR_CLI_PATH = "tools/catalog-generator/src/cli.ts";
const CATALOG_OUTPUT_PATHS = Object.freeze([
  "generated/catalog-impact.receipt.json",
  "generated/catalog-impact.snapshot.json",
  "generated/family-catalog/index.ts",
  "generated/runtime-composition/index.ts",
  "generated/safety-profile/index.ts",
  "generated/strategy-catalog/index.ts",
  VALUATION_OWNER_RUNTIME_COMPOSITION_PATH,
].sort());

// Family code is intentionally default-deny against the central tree.  These
// are protocol-neutral contracts/codecs only; adding a concrete package here
// would turn a Family-specific dependency into a central escape hatch.
const FAMILY_CENTRAL_IMPORT_ALLOWLIST = Object.freeze([
  "packages/family-sdk/runtime-refs/",
  "packages/family-sdk/authoring/",
  "packages/family-sdk/runtime/",
  "packages/family-sdk/search-runtime/",
  "packages/capability-contracts/",
  "packages/canonical-codec/",
  "packages/discovery/src/index.ts",
  "packages/observation/src/index.ts",
  "packages/execution-program/src/index.ts",
  "packages/catalog/src/index.ts",
  "packages/capability-interpreters/src/index.ts",
  // Only the separately frozen pure-contract subtree is a Family dependency;
  // the package root and closure/build helpers remain default-deny.
  "packages/artifact-fingerprint/src/pure/",
  "packages/request-program/src/index.ts",
  // Neutral obligation templates are shared contracts. They carry no venue,
  // instance, route, or admission authority and are safe Family inputs.
  "packages/funding/src/index.ts",
  "packages/credit/src/index.ts",
]);

// Strategy declarations are even narrower than Family code: they may depend
// on neutral authoring/runtime-ref contracts only. Keep this exact-path
// allowlist default-deny so a strategy cannot quietly acquire planner,
// solver, state, execution, or authority ownership through a central package.
const STRATEGY_CENTRAL_IMPORT_ALLOWLIST = Object.freeze([
  "packages/capability-contracts/src/index.ts",
  "packages/canonical-codec/src/index.ts",
  "packages/artifact-fingerprint/src/pure/index.ts",
  "packages/family-sdk/runtime-refs/index.ts",
  "packages/strategy-sdk/src/index.ts",
  "specs/capability-index/src/index.ts",
  "specs/release-intent/src/index.ts",
]);

// Concrete valuation semantics are plugins, not central policy.  Owners may
// depend only on their frozen wire/runtime contracts; generated composition
// is the sole production import surface for a concrete owner.
const VALUATION_OWNER_CENTRAL_IMPORT_ALLOWLIST = Object.freeze([
  "packages/asset-ref/",
  "packages/canonical-codec/",
  "specs/economic-valuation-owner/",
]);

// These public package roots still mix a constructor/issuer with ordinary
// ports.  They are sensitive until physically split; listing them here makes
// direct runtime imports fail closed instead of hiding behind a public index.
const SENSITIVE_PUBLIC_CONSTRUCTOR_PATHS = new Set([
  "packages/checkpoint/src/index.ts",
  "packages/durable-store/src/index.ts",
  "packages/scheduler/src/index.ts",
  RELEASE_ASSEMBLED_ACCEPTANCE_PATH,
]);

/**
 * These mixed public package roots contain both neutral runtime machinery and
 * authority constructors.  The dependency gate must inspect the actual
 * runtime import instead of treating every `WorkScheduler`/clock import as an
 * authority edge.  Unknown or unreadable import shapes remain fail-closed.
 */
const SENSITIVE_PUBLIC_RUNTIME_IMPORTS = new Map<string, ReadonlySet<string>>([
  ["packages/scheduler/src/index.ts", new Set(["createQualifiedExecutorRegistry", "assertQualifiedExecutorRegistry"])],
  [RELEASE_ASSEMBLED_ACCEPTANCE_PATH, new Set([
    "installQualifiedReleaseAcceptanceRunnerV1",
    "readAuthorizedQualifiedReleaseRunnerWireV1",
    "observeQualifiedReleaseAcceptanceAdvisoryV1",
    "readQualifiedReleaseLineageObservationV1",
  ])],
]);

/** Exact production process adapters own the two approved external
 * executables. Other production code remains forbidden from spawning. */
const CHILD_PROCESS_RUNTIME_OWNER_PATHS = new Set([
  "packages/runtime-release-authority/src/internal/external-proof-owner.ts",
  "runtime/revm-workers/src/node-worker-factory.ts",
]);

// These are current non-public constructor/issuer paths.  `/src/internal/`
// itself is also sensitive below, so a future internal constructor cannot be
// reached merely because it was omitted from this list.
const KNOWN_AUTHORITY_CONSTRUCTOR_PATHS = new Set([
  GATE_CORE_MATERIAL_PROVIDER_STATE_PATH,
  GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH,
  GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH,
  GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH,
  COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH,
  COLLECTOR_PREDICATE_MATERIAL_SOURCE_ISSUER_PATH,
  COLLECTOR_PREDICATE_MATERIAL_BRIDGE_ISSUER_PATH,
  PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH,
  ROOT_PREDICATE_MATERIAL_SOURCE_OWNER_PATH,
  ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH,
  ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH,
  ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH,
  RELEASE_OWNED_OBSERVER_STORE_PATH,
  RUNTIME_RELEASE_OBSERVER_STORE_OWNER_PATH,
  "packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts",
  RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH,
  "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts",
  "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts",
  "packages/runtime-release-authority/src/internal/family-runtime-owner.ts",
  "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts",
  RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH,
  EVIDENCE_EMITTER_SIX_STEP_PRODUCTION_OWNER_PATH,
  STARTUP_SIX_STEP_ROUTE_PARENT_OWNER_PATH,
  "packages/attestation/src/internal-authority.ts",
  WORK_PLANE_CALLER_AUTHORITY_STATE_PATH,
  WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH,
  "packages/work-plane/src/internal/family-execution-port.ts",
  "packages/candidate-partition-runtime/src/internal/reader-state.ts",
  "packages/candidate-partition-runtime/src/internal/reader-issuer.ts",
  "packages/candidate-partition-runtime/src/internal/reader-consumer.ts",
  "packages/checkpoint/src/candidate-partition.ts",
  "packages/checkpoint/src/sealed-run.ts",
  CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH,
  CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH,
  CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH,
  CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH,
  "packages/sealed-run-runtime/src/internal/reader-state.ts",
  "packages/sealed-run-runtime/src/internal/reader-issuer.ts",
  "packages/sealed-run-runtime/src/internal/reader-consumer.ts",
  "specs/candidate-partition-authority/src/internal/issuer-state.ts",
  "specs/candidate-partition-authority/src/internal/issuer-owner.ts",
  "specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
]);

const GATE_CORE_AUTHORITY_CONSTRUCTOR_PATHS = new Set([
  GATE_CORE_MATERIAL_PROVIDER_STATE_PATH,
  GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH,
  GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH,
  GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH,
]);

// Only the declaring owner may import the current internal constructor.  This
// is an exact edge manifest, not a package-wide or wildcard exception.
const AUTHORITY_OWNER_EDGES = new Set([
  ...TERMINAL_PHASE_INTERNAL_OWNER_EDGES,
  `${RUNTIME_RELEASE_SIX_STEP_PRODUCTION_OWNER_PATH}\u2192${CHECKPOINT_PUBLIC_PATH}`,
  ...PREDICATE_MATERIAL_SOURCE_OWNER_EDGES,
  ...PRODUCTION_RELEASE_ADVISORY_OWNER_EDGES,
  ...PRE_RELEASE_BOUNDARY_OWNER_EDGES,
  ...CATALOG_NOMINATION_REUSE_OWNER_EDGES,
  ...ARTIFACT_LINEAGE_STAGE_ONE_OWNER_EDGES,
  `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}`,
  `${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`,
  `${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`,
  `${RELEASE_GENERIC_CORE_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`,
  `${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}`,
  `${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${RELEASE_RUNTIME_PATH}`,
  "packages/request-program/src/index.ts\u2192packages/request-program/src/internal/issuer-state.ts",
  "packages/request-program/src/internal/issuer-owner.ts\u2192packages/request-program/src/internal/issuer-state.ts",
  "packages/capability-interpreters/src/index.ts\u2192packages/capability-interpreters/src/internal/registry-state.ts",
  "packages/capability-interpreters/src/internal/registry-owner.ts\u2192packages/capability-interpreters/src/internal/registry-state.ts",
  "packages/runtime-release-authority/src/index.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/index.ts\u2192packages/runtime-release-authority/src/internal/bootstrap.ts",
  "packages/runtime-release-authority/src/internal/authority-consumer.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/authority-consumer.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-owner.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts",
  "packages/runtime-release-authority/src/strategy-runtime-consumer.ts\u2192packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts",
  "packages/runtime-release-authority/src/internal/attestation-proof-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-owner.ts",
  "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-owner.ts",
  "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
  "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/scheduler/src/internal/authority-owner.ts",
  "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/scheduler/src/internal/authority-consumer.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-owner.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-owner.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/family-runtime-owner.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts",
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_STARTUP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${FULL_FAMILY_OBSERVER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}`,
  `${FULL_FAMILY_OBSERVER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}`,
  `${FULL_FAMILY_OBSERVATION_PORT_PUBLIC_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`,
  `${FULL_FAMILY_COLLECTOR_PORT_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`,
  `${SIX_STEP_OBSERVATION_PORT_PUBLIC_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`,
  `${SIX_STEP_COLLECTOR_PORT_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`,
  `${SIX_STEP_PROCESS_PUBLIC_PATH}\u2192${SIX_STEP_PROCESS_OWNER_PATH}`,
  `${SIX_STEP_PROCESS_OWNER_PATH}\u2192${SIX_STEP_COMPLETE_APPEND_OWNER_PATH}`,
  `${FAMILY_COMPOSITION_PUBLIC_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`,
  `${SEARCHER_RETH_SOURCE_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`,
  `${SEARCHER_APPLICATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${SEARCHER_APPLICATION_OWNER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}`,
  `packages/runtime-release-authority/src/performance-runtime-consumer.ts\u2192${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}`,
  `packages/runtime-release-authority/src/searcher-startup-consumer.ts\u2192${RUNTIME_RELEASE_STARTUP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
  `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${PROCESS_RESOURCE_SCOPE_OWNER_PATH}`,
  `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
  `${RUNTIME_RELEASE_STARTUP_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${RUNTIME_RELEASE_STARTUP_OWNER_PATH}\u2192${STARTUP_READY_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
  `${RUNTIME_RELEASE_DISCOVERY_OWNER_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
  `${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192packages/search-pipeline/src/index.ts`,
  `${FAMILY_EXECUTION_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
  `${WORK_PLANE_PUBLIC_PATH}\u2192${WORK_PLANE_CALLER_AUTHORITY_STATE_PATH}`,
  `${WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH}\u2192${WORK_PLANE_CALLER_AUTHORITY_STATE_PATH}`,
  `${WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
  `${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}\u2192${SCHEDULER_AUTHORITY_CONSUMER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${FAMILY_RUNTIME_COMPOSITION_PATH}`,
  "packages/runtime-release-authority/src/internal/family-runtime-owner.ts\u2192packages/family-composition/src/internal/generated-runtime-composition.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/attestation/src/internal/composition.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/checkpoint/src/candidate-partition.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/checkpoint/src/index.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/work-plane/src/internal/family-execution-port.ts",
  `${RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH}\u2192${FAMILY_EXECUTION_OWNER_PATH}`,
  `${RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH}\u2192packages/family-composition/src/internal/generated-runtime-composition.ts`,
  `${SEARCHER_RELEASE_RUNTIME_OWNER_PATH}\u2192${RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH}`,
  "packages/runtime-release-authority/src/internal/family-runtime-owner.ts\u2192packages/work-plane/src/internal/family-execution-port.ts",
  "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/attestation/src/internal/validation-authority-verifier.ts",
  "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/checkpoint/src/index.ts",
  `packages/runtime-release-authority/src/internal/bootstrap.ts\u2192${RUNTIME_RELEASE_REVM_OWNER_PATH}`,
  `packages/runtime-release-authority/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_OWNER_PATH}`,
  `packages/runtime-release-authority/src/internal/ready-binding-consumer.ts\u2192${RUNTIME_RELEASE_READY_BINDING_OWNER_PATH}`,
  `packages/ready-generation/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_CONSUMER_PATH}`,
  `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192packages/scheduler/src/internal/authority-consumer.ts`,
  `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
  `${REVM_WORKER_LIFECYCLE_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
  `${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
  `${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${PROCESS_RESOURCE_SCOPE_OWNER_PATH}`,
  "packages/attestation/src/internal/composition-resolution.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts",
  "packages/attestation/src/index.ts\u2192packages/attestation/src/internal-authority.ts",
  "packages/attestation/src/index.ts\u2192packages/attestation/src/internal/identity-proof.ts",
  "packages/attestation/src/index.ts\u2192packages/attestation/src/internal/outcome-proof.ts",
  "packages/attestation/src/internal/engine.ts\u2192packages/attestation/src/internal-authority.ts",
  "packages/attestation/src/internal/composition-resolution.ts\u2192packages/attestation/src/internal-authority.ts",
  "packages/attestation/src/internal/composition.ts\u2192packages/attestation/src/internal/engine.ts",
  "packages/attestation/src/internal/composition.ts\u2192packages/attestation/src/internal/composition-resolution.ts",
  "packages/attestation/src/internal/engine.ts\u2192packages/attestation/src/internal/validation-authority-issuer.ts",
  "packages/attestation/src/internal/engine.ts\u2192packages/attestation/src/internal/validation-authority-state.ts",
  "packages/attestation/src/internal/validation-authority-issuer.ts\u2192packages/attestation/src/internal/validation-authority-state.ts",
  "packages/attestation/src/internal/validation-authority-verifier.ts\u2192packages/attestation/src/internal/validation-authority-state.ts",
  "packages/checkpoint/src/index.ts\u2192packages/attestation/src/internal/validation-authority-verifier.ts",
  "packages/checkpoint/src/index.ts\u2192packages/attestation/src/internal/validation-authority-rehydrator.ts",
  "packages/work-plane/src/internal/family-execution-port.ts\u2192packages/work-plane/src/index.ts",
  "packages/checkpoint/src/index.ts\u2192packages/checkpoint/src/candidate-partition.ts",
  "packages/checkpoint/src/candidate-partition.ts\u2192packages/candidate-partition-runtime/src/internal/reader-issuer.ts",
  "packages/attestation/src/internal/engine.ts\u2192packages/candidate-partition-runtime/src/internal/reader-consumer.ts",
  "packages/scheduler/src/internal/authority-owner.ts\u2192packages/scheduler/src/internal/authority-state.ts",
  "packages/scheduler/src/internal/authority-consumer.ts\u2192packages/scheduler/src/internal/authority-state.ts",
  "packages/work-plane/src/internal/family-execution-port.ts\u2192packages/scheduler/src/internal/authority-consumer.ts",
  "packages/candidate-partition-runtime/src/internal/reader-issuer.ts\u2192packages/candidate-partition-runtime/src/internal/reader-state.ts",
  "packages/candidate-partition-runtime/src/internal/reader-consumer.ts\u2192packages/candidate-partition-runtime/src/internal/reader-state.ts",
  "packages/checkpoint/src/index.ts\u2192packages/checkpoint/src/sealed-run.ts",
  `packages/checkpoint/src/index.ts\u2192${CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH}`,
  `${CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH}`,
  `${CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH}`,
  `${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH}`,
  `packages/checkpoint/src/index.ts\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH}`,
  `${CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH}`,
  `${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH}`,
  `${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`,
  `${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`,
  "packages/checkpoint/src/sealed-run.ts\u2192packages/sealed-run-runtime/src/internal/reader-issuer.ts",
  "packages/ready-generation/src/index.ts\u2192packages/sealed-run-runtime/src/internal/reader-consumer.ts",
  "packages/sealed-run-runtime/src/internal/reader-issuer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts",
  "packages/sealed-run-runtime/src/internal/reader-consumer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts",
  "packages/checkpoint/src/index.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
  "packages/checkpoint/test/candidate-partition-authority-fixture.ts\u2192specs/candidate-partition-authority/src/internal/issuer-owner.ts",
  "specs/candidate-partition-authority/src/internal/issuer-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts",
  "specs/candidate-partition-authority/src/internal/issuer-consumer.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts",
  // Attestation proof/state modules are one exact owner chain; importing an
  // internal file from another package remains default-deny.
  "packages/attestation/src/internal/engine.ts\u2192packages/attestation/src/internal/identity-proof.ts",
  "packages/attestation/src/internal/identity-proof.ts\u2192packages/attestation/src/internal-authority.ts",
  "packages/attestation/src/internal/outcome-proof.ts\u2192packages/attestation/src/internal-authority.ts",
  "packages/attestation/src/internal/validation-authority-issuer.ts\u2192packages/attestation/src/internal/identity-proof.ts",
  "packages/attestation/src/internal/validation-authority-issuer.ts\u2192packages/attestation/src/internal/outcome-proof.ts",
  "packages/attestation/src/internal/validation-authority-rehydrator.ts\u2192packages/attestation/src/internal/validation-authority-issuer.ts",
  "packages/attestation/src/internal/validation-authority-rehydrator.ts\u2192packages/attestation/src/internal/validation-authority-state.ts",
  "packages/attestation/src/internal/validation-authority-rehydrator.ts\u2192packages/attestation/src/internal/validation-authority-verifier.ts",
  "packages/attestation/src/internal/validation-authority-state.ts\u2192packages/attestation/src/internal-authority.ts",
  // Durable persistence and generated Family assembly are narrow owner seams,
  // not package-wide permissions.
  "packages/canonical-source/src/index.ts\u2192packages/durable-store/src/index.ts",
  "packages/checkpoint/src/index.ts\u2192packages/durable-store/src/index.ts",
  "packages/family-composition/src/index.ts\u2192packages/family-composition/src/internal/generated-runtime-composition.ts",
  "packages/family-sdk/runtime/internal/authority-owner.ts\u2192packages/capability-interpreters/src/internal/registry-owner.ts",
  "packages/family-sdk/runtime/internal/authority-owner.ts\u2192packages/request-program/src/internal/issuer-owner.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-owner.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/durable-store/src/index.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/family-composition/src/internal/generated-runtime-composition.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/ready-binding-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/ready-binding-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts",
  "packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/scheduler/src/index.ts",
  "packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192runtime/revm-workers/src/protocol.ts",
  // Generated runtime is the sole generated consumer of this factory.
  "generated/runtime-composition/index.ts\u2192packages/family-composition/src/internal/generated-runtime-composition.ts",
  // Exact composition-owner edges; package-wide internal imports remain
  // forbidden and every new owner must be registered explicitly here.
  `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_SEARCH_OWNER_PATH}`,
  `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
  `${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
  `${SEARCH_RUNTIME_CORE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}`,
  `${STRATEGY_COMPOSITION_PUBLIC_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
  `${STRATEGY_GENERATED_RUNTIME_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
  `${RUNTIME_RELEASE_STRATEGY_OWNER_PATH}\u2192${STRATEGY_TRIGGER_OWNER_PATH}`,
  "apps/searcher-runtime/src/index.ts\u2192apps/searcher-runtime/src/internal/ports.ts",
  "packages/producer/src/index.ts\u2192packages/producer/src/internal/owners.ts",
  "packages/final-sim/src/index.ts\u2192packages/final-sim/src/internal/final-simulation-owner.ts",
  "packages/final-sim/src/index.ts\u2192packages/final-sim/src/internal/reth-state-owner.ts",
  "packages/final-sim/src/index.ts\u2192packages/final-sim/src/internal/state-snapshot.ts",
  "packages/final-sim/src/index.ts\u2192runtime/revm-workers/src/internal/authority.ts",
  "packages/final-sim/src/internal/reth-state-owner.ts\u2192packages/final-sim/src/internal/state-snapshot.ts",
  "packages/final-sim/src/internal/state-snapshot.ts\u2192runtime/revm-workers/src/internal/authority.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/attestation/src/internal/family-program-adapter.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/discovery-owner.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/startup-runtime/src/internal/ready-owner.ts",
  "packages/runtime-release-authority/src/internal/family-runtime-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/family-runtime-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts\u2192packages/strategy-composition/src/internal/generated-runtime-composition.ts",
  "packages/startup-runtime/src/index.ts\u2192packages/startup-runtime/src/internal/ready-owner.ts",
  "packages/startup-runtime/src/index.ts\u2192packages/startup-runtime/src/internal/runtime-owner.ts",
  "packages/strategy-composition/src/index.ts\u2192packages/strategy-composition/src/internal/trigger-owner.ts",
  "generated/runtime-composition/index.ts\u2192packages/strategy-composition/src/internal/generated-runtime-composition.ts",
]);

/** Exact framework-owner edges into the REVM transport.  These owners join
 * deployment capabilities to the worker port; arbitrary central packages
 * and Family code still cannot import production runtime implementations. */
const CENTRAL_RUNTIME_OWNER_EDGES = new Set([
  "packages/final-sim/src/index.ts\u2192runtime/revm-workers/src/index.ts",
  "packages/final-sim/src/index.ts\u2192runtime/revm-workers/src/lifecycle.ts",
  "packages/final-sim/src/internal/state-snapshot.ts\u2192runtime/revm-workers/src/internal/authority.ts",
  "packages/final-sim/src/internal/reth-state-owner.ts\u2192runtime/revm-workers/src/lifecycle.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192runtime/revm-workers/src/lifecycle.ts",
  `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${REVM_WORKER_LIFECYCLE_PATH}`,
  `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
  "packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192runtime/revm-workers/src/lifecycle.ts",
  "packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192runtime/revm-workers/src/internal/authority.ts",
  "packages/final-sim/src/index.ts\u2192runtime/revm-workers/src/internal/authority.ts",
  "packages/final-sim/src/internal/state-snapshot.ts\u2192runtime/revm-workers/src/lifecycle.ts",
  "packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192runtime/revm-workers/src/protocol.ts",
  `${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
]);

const AUTHORITY_NAMED_IMPORTS = new Map<string, readonly string[]>([
  ...TERMINAL_PHASE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.named,
  ] as const),
  ...PREDICATE_MATERIAL_SOURCE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.named,
  ] as const),
  ...PRODUCTION_RELEASE_ADVISORY_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.named,
  ] as const),
  ...PRE_RELEASE_BOUNDARY_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.named,
  ] as const),
  ...CATALOG_NOMINATION_REUSE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.named,
  ] as const),
  ...ARTIFACT_LINEAGE_STAGE_ONE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.named,
  ] as const),
  [
    `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}`,
    ["issueCommonEnvelopeAuthorityPortV1"],
  ],
  [`${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`, ["registerCommonEnvelopeAuthorityPortV1"]],
  [`${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`, ["assertCommonEnvelopeAuthorityPortV1", "invokeCommonEnvelopeAuthorityPortV1"]],
  [`${RELEASE_GENERIC_CORE_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`, ["assertCommonEnvelopeAuthorityPortV1"]],
  [`${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}`, ["issuePredicateDomainMaterialCapabilityV1"]],
  [`${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, []],
  [`${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, ["registerPredicateDomainMaterialCapabilityV1"]],
  [`${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, ["readPredicateDomainMaterialCapabilityV1"]],
  [`${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, []],
  [`${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, []],
  [
    `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${RELEASE_RUNTIME_PATH}`,
    ["assembleReleaseGateInvocations", "evaluateAssembledReleaseGateInvocations"],
  ],
  [
    `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_SEARCH_OWNER_PATH}`,
    ["issueCoarseEnumerationBindingV1", "issueCoarseRouteBindingV1"],
  ],
  [
    `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
    ["routeCoarseAttemptEvidenceReaderV1"],
  ],
  [
    `${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
    ["registerRouteCoarseAttemptEvidenceAuthorityV1"],
  ],
  [
    `${SEARCH_RUNTIME_CORE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}`,
    ["createRouteCoarseAttemptEvidenceOwnerV1"],
  ],
  [
    `${STRATEGY_COMPOSITION_PUBLIC_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
    ["readGeneratedStrategyRuntimeCompositionCapability"],
  ],
  [
    `${STRATEGY_GENERATED_RUNTIME_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
    ["issueGeneratedStrategyRuntimeCompositionCapability"],
  ],
  [
    `${RUNTIME_RELEASE_STRATEGY_OWNER_PATH}\u2192${STRATEGY_TRIGGER_OWNER_PATH}`,
    ["issueStrategyPlanningTriggerCapabilityV1"],
  ],
  [
    "packages/runtime-release-authority/src/index.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
    ["registerRuntimeReleaseAuthority", "stateForRuntimeReleaseCapability"],
  ],
  [
    "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
    ["assertActiveRuntimeReleaseAuthorityState"],
  ],
  [
    "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-owner.ts",
    ["issueCandidatePartitionProofIssuerPort"],
  ],
  [
    "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
    ["assertIssuedCandidatePartitionProofIssuer"],
  ],
  [
    "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
    ["assertActiveRuntimeReleaseAuthorityState"],
  ],
  [
    "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/scheduler/src/internal/authority-owner.ts",
    ["issueQualifiedExecutorAuthorityIssuer"],
  ],
  [
    "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/scheduler/src/internal/authority-consumer.ts",
    ["assertIssuedQualifiedExecutorAuthorityIssuer"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-owner.ts",
    ["issueRuntimeReleaseAttestationComposition"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-owner.ts",
    ["issueRuntimeReleaseAttestationProofPort"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts",
    ["issueRuntimeReleaseCandidatePartitionProofIssuer"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts",
    [
      "assertRuntimeReleaseQualifiedExecutorAuthorityInitialCapability",
      "issueRuntimeReleaseQualifiedExecutorAuthorityIssuer",
    ],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/family-runtime-owner.ts",
    ["issueRuntimeReleaseFamilyRuntimeAuthorityCapability"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts",
    ["issueRuntimeReleasePersistedAttestationPort"],
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
    ["readQualifiedSharedSchedulerRuntimePort"],
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
    ["readRuntimeReleaseQualifiedDiscoverySourcePort"],
  ],
  [
    `${RUNTIME_RELEASE_DISCOVERY_OWNER_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
    ["assertRuntimeReleaseQualifiedDiscoverySourceState"],
  ],
  [
    `${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
    ["assertActiveRuntimeReleaseAuthorityState"],
  ],
  [
    `${FAMILY_EXECUTION_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
    ["readQualifiedSharedSchedulerRuntimePort"],
  ],
  [
    `${WORK_PLANE_PUBLIC_PATH}\u2192${WORK_PLANE_CALLER_AUTHORITY_STATE_PATH}`,
    ["readWorkPlaneCallerCapability", "workPlaneCallerIntentBindingHash"],
  ],
  [
    `${WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH}\u2192${WORK_PLANE_CALLER_AUTHORITY_STATE_PATH}`,
    ["registerWorkPlaneCallerCapability", "workPlaneCallerIntentBindingHash"],
  ],
  [
    `${WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
    ["readQualifiedSharedSchedulerRuntimePort"],
  ],
  [
    `${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}\u2192${SCHEDULER_AUTHORITY_CONSUMER_PATH}`,
    ["assertIssuedQualifiedExecutorAuthorityIssuer"],
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${FAMILY_RUNTIME_COMPOSITION_PATH}`,
    ["createReleaseFamilyRuntimeComposition"],
  ],
  [
    "packages/runtime-release-authority/src/internal/family-runtime-owner.ts\u2192packages/family-composition/src/internal/generated-runtime-composition.ts",
    [
      "assertGeneratedFamilyRuntimeFactory",
      "issueGeneratedFamilyRuntimeAuthorityCapability",
      "readGeneratedFamilyRuntimeFactoryMetadata",
    ],
  ],
  [
    `packages/runtime-release-authority/src/internal/bootstrap.ts\u2192${RUNTIME_RELEASE_REVM_OWNER_PATH}`,
    ["issueRuntimeReleaseRevmWorkerAuthorityIssuer", "readRuntimeReleaseRevmWorkerDeploymentPort"],
  ],
  [
    `packages/runtime-release-authority/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_OWNER_PATH}`,
    ["issueRuntimeReleaseReadyBindingPort"],
  ],
  [
    `packages/runtime-release-authority/src/internal/ready-binding-consumer.ts\u2192${RUNTIME_RELEASE_READY_BINDING_OWNER_PATH}`,
    ["isIssuedRuntimeReleaseReadyBindingPort"],
  ],
  [
    `packages/ready-generation/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_CONSUMER_PATH}`,
    ["assertIssuedRuntimeReleaseReadyBindingPort"],
  ],
  [
    `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192packages/scheduler/src/internal/authority-consumer.ts`,
    ["assertIssuedQualifiedExecutorAuthorityIssuer"],
  ],
  [
    `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
    ["issueRevmWorkerAuthorityIssuer", "readIssuedRevmWorkerDeploymentPort"],
  ],
  [
    `${REVM_WORKER_LIFECYCLE_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
    ["assertIssuedRevmWorkerAuthorityIssuer"],
  ],
  [
    `${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
    ["captureRevmWorkerResourceObservation", "readRevmWorkerResourceObservation"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/attestation/src/internal/composition.ts",
    ["createAttestationService"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/checkpoint/src/candidate-partition.ts",
    ["createCandidatePartitionBootstrap", "candidatePartitionBootstrapReader"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/checkpoint/src/index.ts",
    ["createCheckpointStore"],
  ],
  [
    "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/work-plane/src/internal/family-execution-port.ts",
    ["createSchedulerOwnedFamilyExecutionPort"],
  ],
  [
    `${RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH}\u2192${FAMILY_EXECUTION_OWNER_PATH}`,
    ["issueQualifiedPhysicalExecutionPort"],
  ],
  [
    `${RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH}\u2192packages/family-composition/src/internal/generated-runtime-composition.ts`,
    ["executeGeneratedFamilyPhysicalLifecycle", "readGeneratedFamilyRuntimeFactoryMetadata"],
  ],
  [
    `${SEARCHER_RELEASE_RUNTIME_OWNER_PATH}\u2192${RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH}`,
    ["issueRuntimeReleaseHttpFamilyPhysicalExecutionPortV1"],
  ],
  [
    "packages/runtime-release-authority/src/internal/family-runtime-owner.ts\u2192packages/work-plane/src/internal/family-execution-port.ts",
    [
      "assertIssuedFamilyFrozenProgramExecutionPort",
      "createFamilyRuntimeStageExecutors",
      "readIssuedFamilyFrozenProgramExecutionBinding",
    ],
  ],
  [
    "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
    ["assertActiveRuntimeReleaseAuthorityState"],
  ],
  [
    "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/attestation/src/internal/validation-authority-verifier.ts",
    ["assertIssuedAttestationService"],
  ],
  [
    "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/checkpoint/src/index.ts",
    ["assertIssuedCheckpointStore"],
  ],
  [
    "packages/runtime-release-authority/src/internal/authority-consumer.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
    ["assertIssuedRuntimeReleaseAuthorityState"],
  ],
  [
    "packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-owner.ts",
    ["readIssuedRuntimeReleaseAttestationComposition"],
  ],
  [
    "packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-owner.ts",
    ["readIssuedRuntimeReleaseAttestationProof"],
  ],
  [
    "packages/runtime-release-authority/src/strategy-runtime-consumer.ts\u2192packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts",
    ["assertIssuedRuntimeReleaseStrategyRuntimeService"],
  ],
  [
    "packages/attestation/src/internal/composition-resolution.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts",
    ["assertIssuedRuntimeReleaseAttestationComposition"],
  ],
  [
    "packages/checkpoint/src/candidate-partition.ts\u2192packages/candidate-partition-runtime/src/internal/reader-issuer.ts",
    ["issueCheckpointCandidatePartitionReader"],
  ],
  [
    "packages/attestation/src/internal/engine.ts\u2192packages/candidate-partition-runtime/src/internal/reader-consumer.ts",
    ["assertIssuedCandidatePartitionReader"],
  ],
  [
    "packages/scheduler/src/internal/authority-owner.ts\u2192packages/scheduler/src/internal/authority-state.ts",
    ["registerQualifiedExecutorAuthorityIssuer"],
  ],
  [
    "packages/scheduler/src/internal/authority-consumer.ts\u2192packages/scheduler/src/internal/authority-state.ts",
    ["isQualifiedExecutorAuthorityIssuer"],
  ],
  [
    "packages/work-plane/src/internal/family-execution-port.ts\u2192packages/scheduler/src/internal/authority-consumer.ts",
    ["assertIssuedQualifiedExecutorAuthorityIssuer"],
  ],
  [
    "packages/candidate-partition-runtime/src/internal/reader-issuer.ts\u2192packages/candidate-partition-runtime/src/internal/reader-state.ts",
    ["registerIssuedReader"],
  ],
  [
    "packages/candidate-partition-runtime/src/internal/reader-consumer.ts\u2192packages/candidate-partition-runtime/src/internal/reader-state.ts",
    ["isIssuedReader"],
  ],
  ["packages/checkpoint/src/sealed-run.ts\u2192packages/sealed-run-runtime/src/internal/reader-issuer.ts", ["issueCheckpointSealedRunReader"]],
  [`packages/checkpoint/src/index.ts\u2192${CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH}`, ["registerCheckpointReadyStage12EvidenceReader"]],
  [`${CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH}`, ["registerReadyStage12EvidenceReader"]],
  [`${CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH}`, ["isReadyStage12EvidenceReader"]],
  [`${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH}`, ["assertCheckpointReadyStage12EvidenceReader"]],
  [`packages/checkpoint/src/index.ts\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH}`, ["registerCheckpointReadyFullFamilyEvidenceReader"]],
  [`${CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH}`, ["registerReadyFullFamilyEvidenceReader"]],
  [`${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH}`, ["isReadyFullFamilyEvidenceReader"]],
  [`${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`, ["assertCheckpointReadyFullFamilyEvidenceReader"]],
  [`${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`, ["assertCheckpointReadyFullFamilyEvidenceReader"]],
  ["packages/ready-generation/src/index.ts\u2192packages/sealed-run-runtime/src/internal/reader-consumer.ts", ["assertCheckpointSealedRunReader"]],
  ["packages/sealed-run-runtime/src/internal/reader-issuer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts", ["registerSealedRunReader"]],
  ["packages/sealed-run-runtime/src/internal/reader-consumer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts", ["isSealedRunReader"]],
  ["packages/checkpoint/src/index.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts", ["assertIssuedCandidatePartitionProofIssuer"]],
  ["specs/candidate-partition-authority/src/internal/issuer-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts", ["registerCandidatePartitionProofIssuer"]],
  ["specs/candidate-partition-authority/src/internal/issuer-consumer.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts", ["isCandidatePartitionProofIssuer"]],
  ["packages/attestation/src/internal/engine.ts\u2192packages/attestation/src/internal/identity-proof.ts", ["validateIdentityIssuerProof"]],
  ["packages/attestation/src/internal/validation-authority-issuer.ts\u2192packages/attestation/src/internal/identity-proof.ts", ["validateIdentityIssuerProof"]],
  ["packages/attestation/src/internal/validation-authority-issuer.ts\u2192packages/attestation/src/internal/outcome-proof.ts", ["validateOutcomeIssuerProof"]],
  ["packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts\u2192packages/scheduler/src/index.ts", ["assertQualifiedExecutorRegistry"]],
  ["packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts", ["assertRuntimeReleaseQualifiedExecutorAuthorityIssuerBoundTo"]],
  ["packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts", ["assertActiveRuntimeReleaseAuthorityState"]],
  ["packages/runtime-release-authority/src/internal/ready-binding-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts", ["assertActiveRuntimeReleaseAuthorityState"]],
  ["packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/state.ts", ["assertActiveRuntimeReleaseAuthorityState"]],
  [`${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}`, ["issueRuntimeReleasePerformanceRuntimeService"]],
  [`${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_STARTUP_OWNER_PATH}`, ["issueRuntimeReleaseSearcherStartupService"]],
  [`${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`, ["issueRuntimeReleaseFullFamilyTerminalBindingServiceV1"]],
  [`${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`, [
    "readRuntimeReleaseFullFamilyTerminalBindingCapabilityV1",
    "readRuntimeReleaseNativeFullFamilyAuditCapabilityV1",
    "readRuntimeReleaseNativeFullFamilyAuditChunkBytesCapabilityV1",
  ]],
  [`${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`, ["assertActiveRuntimeReleaseAuthorityState"]],
  [`${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192packages/search-pipeline/src/index.ts`, [
    "readIssuedNativeFullFamilyAuditChunkBytesV1",
    "readIssuedNativeFullFamilyAuditManifestV1",
    "readIssuedNativeFullFamilyAuditV1",
    "readIssuedSearchTerminalCapabilityV1",
    "readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1",
    "searchTerminalEvidenceHashV2",
  ]],
  [`${FULL_FAMILY_OBSERVER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}`, [
    "readRuntimeReleaseFullFamilyTerminalBindingV1",
    "readRuntimeReleaseNativeFullFamilyAuditChunkV1",
    "readRuntimeReleaseNativeFullFamilyAuditV1",
  ]],
  [`${FULL_FAMILY_OBSERVER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}`, ["readCheckpointReadyFullFamilyEvidence"]],
  [`${FULL_FAMILY_OBSERVATION_PORT_PUBLIC_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`, ["assertIssuedProductionFullFamilyObservationPortV1"]],
  [`${FULL_FAMILY_COLLECTOR_PORT_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`, ["issueProductionFullFamilyObservationPortV1", "readProductionFullFamilyObservationResultV1"]],
  [`${SIX_STEP_OBSERVATION_PORT_PUBLIC_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`, ["assertIssuedProductionSixStepObservationPortV1"]],
  [`${SIX_STEP_COLLECTOR_PORT_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`, ["issueProductionSixStepObservationPortV1", "readProductionSixStepObservationResultV1"]],
  [`${SIX_STEP_PROCESS_PUBLIC_PATH}\u2192${SIX_STEP_PROCESS_OWNER_PATH}`, ["readSearcherProductionSixStepProcessEvidenceCapabilityV1"]],
  [`${SIX_STEP_PROCESS_OWNER_PATH}\u2192${SIX_STEP_COMPLETE_APPEND_OWNER_PATH}`, ["readSearcherProductionSixStepCompleteAppendMaterialV1"]],
  [`${FAMILY_COMPOSITION_PUBLIC_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`, ["readIssuedCoarseEdgeSweepBindingV1"]],
  [`${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`, ["issueCoarseEdgeSweepBindingV1"]],
  [`${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`, [
    "consumeFullGraphCoarseSweepSourceReadCapabilityV1",
    "readFullGraphCoarseSweepSourceReadCapabilityV1",
  ]],
  [`${SEARCHER_RETH_SOURCE_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`, ["issueFullGraphCoarseSweepSourceReadCapabilityV1"]],
  [`${SEARCHER_APPLICATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}`, ["issueFullGraphCoarseSweepInvocationCapabilityV1"]],
  [`${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}`, [
    "issueFullGraphCoarseSweepCapabilityV1",
    "readIssuedFullGraphCoarseSweepEntryChunkV1",
    "readIssuedFullGraphCoarseSweepManifestV1",
  ]],
  [`${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`, [
    "assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1",
    "readRuntimeReleaseFullGraphCoarseSweepEntryChunkCapabilityV1",
    "readRuntimeReleaseFullGraphCoarseSweepManifestCapabilityV1",
  ]],
  [`${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`, ["issueRuntimeReleaseFullGraphCoarseSweepServiceV1"]],
  [`${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`, ["assertActiveRuntimeReleaseAuthorityState"]],
  [`${SEARCHER_APPLICATION_OWNER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}`, ["assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1"]],
  [`packages/runtime-release-authority/src/performance-runtime-consumer.ts\u2192${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}`, ["assertIssuedRuntimeReleasePerformanceRuntimeService"]],
  [`packages/runtime-release-authority/src/searcher-startup-consumer.ts\u2192${RUNTIME_RELEASE_STARTUP_OWNER_PATH}`, ["assertIssuedRuntimeReleaseSearcherStartupService"]],
  [`${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`, ["assertActiveRuntimeReleaseAuthorityState"]],
  [`${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`, [
    "acknowledgeQualifiedSchedulerPerformanceRange",
    "issueQualifiedSharedSchedulerPerformanceReaderPort",
    "openQualifiedSchedulerPerformanceCursor",
    "readQualifiedSchedulerPerformanceRange",
    "readQualifiedSchedulerWorkCompletionCapability",
    "readQualifiedSchedulerWorkCompletionHandle",
    "sealQualifiedSchedulerPerformanceRange",
  ]],
  [`${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${PROCESS_RESOURCE_SCOPE_OWNER_PATH}`, ["createProcessResourceScopeOwner"]],
  [`${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${PROCESS_RESOURCE_OBSERVER_PATH}`, [
    "abortProcessResourceObservationClaim",
    "claimProcessResourceObservation",
    "commitProcessResourceObservationClaim",
    "ProcessResourceObserver",
    "readClaimedProcessResourceObservation",
  ]],
  [`${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192packages/producer/src/index.ts`, [
    "readIssuedProducerHeadSchedulerCompletionV1",
    "readIssuedProducerHeadTerminalCapabilityV1",
  ]],
  [`${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192packages/startup-runtime/src/index.ts`, ["assertIssuedStartupRuntime"]],
  [`${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`, ["issueRevmWorkerResourceObservationPort"]],
  [`${RUNTIME_RELEASE_STARTUP_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`, ["assertActiveRuntimeReleaseAuthorityState"]],
  [`${RUNTIME_RELEASE_STARTUP_OWNER_PATH}\u2192${STARTUP_READY_OWNER_PATH}`, ["assertIssuedStartupReadyPort"]],
  [`${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${PROCESS_RESOURCE_SCOPE_OWNER_PATH}`, ["readProcessResourceScope"]],
  ["packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/family-composition/src/internal/generated-runtime-composition.ts", ["readGeneratedFamilyRuntimeFactoryMetadata", "readGeneratedFamilySourcePlanRuntimes"]],
  ["packages/family-sdk/runtime/internal/authority-owner.ts\u2192packages/capability-interpreters/src/internal/registry-owner.ts", ["createCapabilityInterpreterRegistryOwner"]],
  ["packages/family-sdk/runtime/internal/authority-owner.ts\u2192packages/request-program/src/internal/issuer-owner.ts", ["createProgramIssuerOwner"]],
  ["packages/canonical-source/src/index.ts\u2192packages/durable-store/src/index.ts", ["SQLiteDurableStore"]],
  ["packages/checkpoint/src/index.ts\u2192packages/durable-store/src/index.ts", ["CASConflictError", "CorruptDurableStoreError", "DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN", "SQLiteDurableStore"]],
  ["generated/runtime-composition/index.ts\u2192packages/family-composition/src/internal/generated-runtime-composition.ts", ["createGeneratedFamilyRuntimeFactory"]],
  ["packages/runtime-release-authority/src/internal/revm-worker-owner.ts\u2192runtime/revm-workers/src/protocol.ts", []],
]);

/** Exact source/runtime owner module locators.  Resolved target identity is
 * necessary but not sufficient: an alternate path or alias must not become a
 * second composition seam for these process-local capabilities. */
const AUTHORITY_MODULE_SPECIFIERS = new Map<string, string>([
  ...TERMINAL_PHASE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.specifier,
  ] as const),
  ...PREDICATE_MATERIAL_SOURCE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.specifier,
  ] as const),
  ...PRODUCTION_RELEASE_ADVISORY_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.specifier,
  ] as const),
  ...PRE_RELEASE_BOUNDARY_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.specifier,
  ] as const),
  ...CATALOG_NOMINATION_REUSE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.specifier,
  ] as const),
  ...PRE_RELEASE_SCHEMA_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.specifier,
  ] as const),
  ...ARTIFACT_LINEAGE_STAGE_ONE_AUTHORITY_IMPORTS.map((edge) => [
    `${edge.from}\u2192${edge.to}`,
    edge.specifier,
  ] as const),
  [
    `${PRE_RELEASE_STAGING_PUBLIC_PATH}\u2192${PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH}`,
    "./internal/pre-release-runtime-receipt-state.ts",
  ],
  [
    `${ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_PATH}\u2192${ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH}`,
    "./internal/artifact-lineage-stage-one-state.ts",
  ],
  [
    `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}`,
    "../../../../acceptance/gate-core/src/internal/common-envelope-authority-issuer.ts",
  ],
  [`${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`, "./material-provider-state.ts"],
  [`${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`, "./internal/material-provider-state.ts"],
  [`${RELEASE_GENERIC_CORE_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`, "./internal/material-provider-state.ts"],
  [`${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}`, "../../../gate-core/src/internal/predicate-domain-material-issuer.ts"],
  [`${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, "../../../gate-core/src/internal/predicate-domain-material-state.ts"],
  [`${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, "./predicate-domain-material-state.ts"],
  [`${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, "./internal/predicate-domain-material-state.ts"],
  [`${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, "./predicate-domain-material-state.ts"],
  [`${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`, "../../../../acceptance/gate-core/src/internal/predicate-domain-material-state.ts"],
  [
    `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${RELEASE_RUNTIME_PATH}`,
    "../../../../acceptance/gate-core/src/generated/release-runtime.ts",
  ],
  [
    `${WORK_PLANE_PUBLIC_PATH}\u2192${WORK_PLANE_CALLER_AUTHORITY_STATE_PATH}`,
    "./internal/caller-authority-state.ts",
  ],
  [
    `${WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH}\u2192${WORK_PLANE_CALLER_AUTHORITY_STATE_PATH}`,
    "./caller-authority-state.ts",
  ],
  [
    `${WORK_PLANE_CALLER_AUTHORITY_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
    "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts",
  ],
  [
    `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_SEARCH_OWNER_PATH}`,
    "../../coarse-economics/src/internal/search-owner.ts",
  ],
  [
    `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
    "./internal/coarse-attempt-evidence-state.ts",
  ],
  [
    `${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
    "./coarse-attempt-evidence-state.ts",
  ],
  [
    `${SEARCH_RUNTIME_CORE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}`,
    "../../search-pipeline/src/internal/coarse-attempt-evidence-owner.ts",
  ],
  [
    `${STRATEGY_COMPOSITION_PUBLIC_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
    "./internal/runtime-composition-authority.ts",
  ],
  [
    `${STRATEGY_GENERATED_RUNTIME_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
    "./runtime-composition-authority.ts",
  ],
  [
    `${RUNTIME_RELEASE_STRATEGY_OWNER_PATH}\u2192${STRATEGY_TRIGGER_OWNER_PATH}`,
    "../../../../packages/strategy-composition/src/internal/trigger-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}`,
    "./performance-runtime-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_STARTUP_OWNER_PATH}`,
    "./searcher-startup-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`,
    "./full-family-terminal-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`,
    "./internal/full-family-terminal-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
    "./state.ts",
  ],
  [
    `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192packages/search-pipeline/src/index.ts`,
    "../../../../packages/search-pipeline/src/index.ts",
  ],
  [
    `${FULL_FAMILY_OBSERVER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}`,
    "../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts",
  ],
  [
    `${FULL_FAMILY_OBSERVER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}`,
    "../../../packages/checkpoint/src/ready-full-family-evidence-consumer.ts",
  ],
  [
    `${FULL_FAMILY_OBSERVATION_PORT_PUBLIC_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`,
    "./internal/owner.ts",
  ],
  [
    `${FULL_FAMILY_COLLECTOR_PORT_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`,
    "../../../packages/full-family-observation-port/src/internal/owner.ts",
  ],
  [
    `${SIX_STEP_OBSERVATION_PORT_PUBLIC_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`,
    "./internal/owner.ts",
  ],
  [
    `${SIX_STEP_COLLECTOR_PORT_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`,
    "../../../packages/six-step-observation-port/src/internal/owner.ts",
  ],
  [
    `${SIX_STEP_PROCESS_PUBLIC_PATH}\u2192${SIX_STEP_PROCESS_OWNER_PATH}`,
    "./internal/owner.ts",
  ],
  [
    `${SIX_STEP_PROCESS_OWNER_PATH}\u2192${SIX_STEP_COMPLETE_APPEND_OWNER_PATH}`,
    "./complete-append-owner.ts",
  ],
  [
    `${FAMILY_COMPOSITION_PUBLIC_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
    "../../coarse-economics/src/internal/full-graph-sweep-owner.ts",
  ],
  [
    `${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
    "../../../coarse-economics/src/internal/full-graph-sweep-owner.ts",
  ],
  [
    `${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`,
    "./source-read-owner.ts",
  ],
  [
    `${SEARCHER_RETH_SOURCE_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`,
    "../../../../packages/full-graph-coarse-sweep/src/internal/source-read-owner.ts",
  ],
  [
    `${SEARCHER_APPLICATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}`,
    "../../../../packages/full-graph-coarse-sweep/src/internal/invocation-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}`,
    "../../../full-graph-coarse-sweep/src/internal/sweep-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
    "./internal/full-graph-coarse-sweep-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
    "./full-graph-coarse-sweep-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
    "./state.ts",
  ],
  [
    `${SEARCHER_APPLICATION_OWNER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}`,
    "../../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts",
  ],
  [
    `packages/runtime-release-authority/src/performance-runtime-consumer.ts\u2192${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}`,
    "./internal/performance-runtime-owner.ts",
  ],
  [
    `packages/runtime-release-authority/src/searcher-startup-consumer.ts\u2192${RUNTIME_RELEASE_STARTUP_OWNER_PATH}`,
    "./internal/searcher-startup-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
    "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${PROCESS_RESOURCE_SCOPE_OWNER_PATH}`,
    "../../../../packages/process-resource-observer/src/internal/scope-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_PERFORMANCE_OWNER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
    "../../../../runtime/revm-workers/src/internal/resource-observation.ts",
  ],
  [
    `${RUNTIME_RELEASE_STARTUP_OWNER_PATH}\u2192${STARTUP_READY_OWNER_PATH}`,
    "../../../../packages/startup-runtime/src/internal/ready-owner.ts",
  ],
  [
    `${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${PROCESS_RESOURCE_SCOPE_OWNER_PATH}`,
    "./internal/scope-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
    "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
    "./discovery-source-authority-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_DISCOVERY_OWNER_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
    "./discovery-source-authority-owner.ts",
  ],
  [
    `${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
    "./state.ts",
  ],
  [
    `${FAMILY_EXECUTION_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
    "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts",
  ],
  [
    `${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}\u2192${SCHEDULER_AUTHORITY_CONSUMER_PATH}`,
    "./authority-consumer.ts",
  ],
  [
    `packages/checkpoint/src/index.ts\u2192${CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH}`,
    "./internal/ready-stage12-evidence-issuer.ts",
  ],
  [
    `${CHECKPOINT_STAGE12_EVIDENCE_ISSUER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH}`,
    "./ready-stage12-evidence-state.ts",
  ],
  [
    `${CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_STATE_PATH}`,
    "./ready-stage12-evidence-state.ts",
  ],
  [
    `${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH}`,
    "../../../checkpoint/src/internal/ready-stage12-evidence-consumer.ts",
  ],
  [
    `packages/checkpoint/src/index.ts\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH}`,
    "./internal/ready-full-family-evidence-issuer.ts",
  ],
  [
    `${CHECKPOINT_FULL_FAMILY_EVIDENCE_ISSUER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH}`,
    "./ready-full-family-evidence-state.ts",
  ],
  [
    `${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_STATE_PATH}`,
    "./ready-full-family-evidence-state.ts",
  ],
  [
    `${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`,
    "../../../checkpoint/src/internal/ready-full-family-evidence-consumer.ts",
  ],
  [
    `${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`,
    "./internal/ready-full-family-evidence-consumer.ts",
  ],
]);

/**
 * REVM receives only the schema-owned worker lease projection.  Keep the
 * mixed value/type import exact: accepting the whole release binding here
 * would move signer/certificate authority across the worker boundary.
 */
const REVM_NARROW_PORT_IMPORTS = new Map<string, readonly { readonly name: string; readonly typeOnly: boolean }[]>([
  [
    `${REVM_WORKER_PROTOCOL_PATH}\u2192${RELEASE_AUTHORITY_SPEC_PATH}`,
    [
      { name: "decodeRuntimeReleaseExecutorLeaseV1", typeOnly: false },
      { name: "RuntimeReleaseExecutorLeaseV1", typeOnly: true },
    ],
  ],
  [
    `${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
    [
      { name: "captureRevmWorkerResourceObservation", typeOnly: false },
      { name: "readRevmWorkerResourceObservation", typeOnly: false },
      { name: "RevmWorkerResourceObservationFactV1", typeOnly: true },
      { name: "RevmWorkerResourceObservationPortV1", typeOnly: true },
    ],
  ],
]);

/** Consumers that must pass an owner-issued process-local port through an
 * exact consumer guard.  A matching structural TypeScript interface is not
 * enough and must not silently become a second authority path. */
const REQUIRED_AUTHORITY_IMPORT_EDGES = new Set([
  ...TERMINAL_PHASE_AUTHORITY_IMPORTS.map((edge) => `${edge.from}\u2192${edge.to}`),
  ...PREDICATE_MATERIAL_SOURCE_AUTHORITY_IMPORTS.map((edge) => `${edge.from}\u2192${edge.to}`),
  ...PRODUCTION_RELEASE_ADVISORY_AUTHORITY_IMPORTS.map((edge) => `${edge.from}\u2192${edge.to}`),
  ...PRE_RELEASE_BOUNDARY_AUTHORITY_IMPORTS.map((edge) => `${edge.from}\u2192${edge.to}`),
  ...CATALOG_NOMINATION_REUSE_AUTHORITY_IMPORTS.map((edge) => `${edge.from}\u2192${edge.to}`),
  ...PRE_RELEASE_SCHEMA_AUTHORITY_IMPORTS.map((edge) => `${edge.from}\u2192${edge.to}`),
  `${PRE_RELEASE_STAGING_PUBLIC_PATH}\u2192${PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH}`,
  ...ARTIFACT_LINEAGE_STAGE_ONE_OWNER_EDGES,
  `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}`,
  `${GATE_CORE_COMMON_ENVELOPE_ISSUER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`,
  `${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`,
  `${RELEASE_GENERIC_CORE_PATH}\u2192${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}`,
  `${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}`,
  `${COLLECTOR_MATERIAL_PROVIDER_SHARED_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_ISSUER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${GATE_CORE_RELEASE_MATERIAL_ASSEMBLER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${GATE_CORE_MATERIAL_PROVIDER_STATE_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${GATE_CORE_PREDICATE_DOMAIN_MATERIAL_STATE_PATH}`,
  `${QUALIFIED_RELEASE_RUNNER_OWNER_PATH}\u2192${RELEASE_RUNTIME_PATH}`,
  `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_SEARCH_OWNER_PATH}`,
  `${SEARCH_PIPELINE_ROUTE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
  `${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_STATE_PATH}`,
  `${SEARCH_RUNTIME_CORE_PATH}\u2192${COARSE_ATTEMPT_EVIDENCE_OWNER_PATH}`,
  `${STRATEGY_COMPOSITION_PUBLIC_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
  `${STRATEGY_GENERATED_RUNTIME_PATH}\u2192${STRATEGY_RUNTIME_COMPOSITION_AUTHORITY_PATH}`,
  `${RUNTIME_RELEASE_STRATEGY_OWNER_PATH}\u2192${STRATEGY_TRIGGER_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
  `${RUNTIME_RELEASE_DISCOVERY_OWNER_PATH}\u2192${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}`,
  `${RUNTIME_RELEASE_DISCOVERY_SOURCE_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_OWNER_PATH}\u2192packages/search-pipeline/src/index.ts`,
  `${FULL_FAMILY_OBSERVER_PATH}\u2192${RUNTIME_RELEASE_FULL_FAMILY_TERMINAL_CONSUMER_PATH}`,
  `${FULL_FAMILY_OBSERVER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}`,
  `${FULL_FAMILY_OBSERVATION_PORT_PUBLIC_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`,
  `${FULL_FAMILY_COLLECTOR_PORT_PATH}\u2192${FULL_FAMILY_OBSERVATION_PORT_OWNER_PATH}`,
  `${SIX_STEP_OBSERVATION_PORT_PUBLIC_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`,
  `${SIX_STEP_COLLECTOR_PORT_PATH}\u2192${SIX_STEP_OBSERVATION_PORT_OWNER_PATH}`,
  `${SIX_STEP_PROCESS_PUBLIC_PATH}\u2192${SIX_STEP_PROCESS_OWNER_PATH}`,
  `${SIX_STEP_PROCESS_OWNER_PATH}\u2192${SIX_STEP_COMPLETE_APPEND_OWNER_PATH}`,
  `${FAMILY_COMPOSITION_PUBLIC_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}\u2192${COARSE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`,
  `${SEARCHER_RETH_SOURCE_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_SOURCE_READ_OWNER_PATH}`,
  `${SEARCHER_APPLICATION_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_INVOCATION_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${FULL_GRAPH_COARSE_SWEEP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_BOOTSTRAP_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}`,
  `${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_OWNER_PATH}\u2192${RUNTIME_RELEASE_STATE_PATH}`,
  `${SEARCHER_APPLICATION_OWNER_PATH}\u2192${RUNTIME_RELEASE_FULL_GRAPH_SWEEP_CONSUMER_PATH}`,
  `${FAMILY_EXECUTION_OWNER_PATH}\u2192${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}`,
  `${SCHEDULER_SHARED_RUNTIME_OWNER_PATH}\u2192${SCHEDULER_AUTHORITY_CONSUMER_PATH}`,
  `packages/ready-generation/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_CONSUMER_PATH}`,
  "packages/checkpoint/src/index.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
  `${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_STAGE12_EVIDENCE_CONSUMER_PATH}`,
  `${STARTUP_RUNTIME_OWNER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`,
  `${CHECKPOINT_FULL_FAMILY_PUBLIC_CONSUMER_PATH}\u2192${CHECKPOINT_FULL_FAMILY_EVIDENCE_CONSUMER_PATH}`,
  "packages/attestation/src/internal/composition-resolution.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts",
  "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/attestation/src/internal/validation-authority-verifier.ts",
  "packages/runtime-release-authority/src/internal/persisted-attestation-owner.ts\u2192packages/checkpoint/src/index.ts",
  `${REVM_WORKER_LIFECYCLE_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
  `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
  `${PROCESS_RESOURCE_OBSERVER_PATH}\u2192${REVM_WORKER_RESOURCE_OBSERVATION_PATH}`,
]);

type CanonicalSink = (chunk: string) => void;

function writeCanonical(value: unknown, sink: CanonicalSink): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    sink(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite hash input");
    sink(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    sink("[");
    value.forEach((item, index) => {
      if (index > 0) sink(",");
      writeCanonical(item, sink);
    });
    sink("]");
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    sink("{");
    entries.forEach(([key, item], index) => {
      if (index > 0) sink(",");
      sink(JSON.stringify(key));
      sink(":");
      writeCanonical(item, sink);
    });
    sink("}");
    return;
  }
  throw new TypeError("unsupported hash input");
}

function canonical(value: unknown): string {
  const chunks: string[] = [];
  writeCanonical(value, (chunk) => chunks.push(chunk));
  return chunks.join("");
}

function hashDomain(domain: string, value: unknown): string {
  const hash = createHash("sha256").update(domain).update("\0");
  writeCanonical(value, (chunk) => hash.update(chunk));
  return `0x${hash.digest("hex")}`;
}

/** Independently recomputed here; the release generator is not a trust input. */
export function computeImplementationExportDigest(
  modulePath: string,
  exportName: string,
  moduleContentSha256: string,
): string {
  return hashDomain("aloha/implementation-export/v1", {
    modulePath,
    exportName,
    moduleContentSha256,
  });
}

export function computePredicateCompositionLeafDigest(
  entry: Omit<ReleasePredicateBomEntryV1, "entrypointId" | "oracleEntrypointId" | "materialProviderEntrypointId" | "compositionLeafDigest">,
): string {
  return hashDomain("aloha/predicate-composition-leaf/v2", {
    predicateId: entry.predicateId,
    predicateSpecDigest: entry.predicateSpecDigest,
    predicateProgramDescriptorDigest: entry.predicateProgramDescriptorDigest,
    oracleProgramDescriptorDigest: entry.oracleProgramDescriptorDigest,
    adapterVersion: entry.adapterVersion,
    oracleVersion: entry.oracleVersion,
    modulePath: entry.modulePath,
    exportName: entry.exportName,
    oracleModulePath: entry.oracleModulePath,
    oracleExportName: entry.oracleExportName,
    predicateImplementationExportDigest: entry.predicateImplementationExportDigest,
    oracleImplementationExportDigest: entry.oracleImplementationExportDigest,
    materialProviderModulePath: entry.materialProviderModulePath,
    materialProviderExportName: entry.materialProviderExportName,
    materialProviderContractDigest: entry.materialProviderContractDigest,
    materialProviderImplementationExportDigest: entry.materialProviderImplementationExportDigest,
    commonEnvelopeRoleContractVersion: entry.commonEnvelopeRoleContractVersion,
  });
}

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

function abs(root: string, path: string): string {
  return resolve(root, path);
}

function rel(root: string, path: string): string {
  return posixPath(relative(root, path));
}

function isInside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function physicalRoot(root: string, diagnostics: BoundaryDiagnostic[]): string | null {
  try {
    return resolve(realpathSync(root));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "compiler-root-unreadable", ".", String(error)));
    return null;
  }
}

function compilerPath(
  root: string,
  physicalRepoRoot: string,
  candidate: string,
  tracked: ReadonlyMap<string, TrackedFile>,
  diagnostics: BoundaryDiagnostic[],
  role: "root" | "source",
): string | null {
  const lexical = resolve(candidate);
  const displayPath = posixPath(relative(root, lexical)) || posixPath(candidate);
  if (!isInside(root, lexical)) {
    diagnostics.push(diagnostic("invalid", role === "root" ? "compiler-root-outside-root" : "compiler-source-outside-root", displayPath, "Compiler input resolves outside the exact repository root"));
    return null;
  }
  let physical: string;
  try {
    physical = resolve(realpathSync(lexical));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", role === "root" ? "compiler-root-unreadable" : "compiler-source-unreadable", displayPath, String(error)));
    return null;
  }
  if (!isInside(physicalRepoRoot, physical)) {
    diagnostics.push(diagnostic("invalid", role === "root" ? "compiler-root-symlink" : "compiler-source-symlink", displayPath, "Compiler input is a symlink whose target escapes the exact repository root"));
    return null;
  }
  const targetPath = rel(physicalRepoRoot, physical);
  if (!tracked.has(targetPath)) {
    diagnostics.push(diagnostic("invalid", role === "root" ? "compiler-root-not-tracked" : "compiler-source-not-tracked", targetPath, "Compiler input is not present in the exact Git denominator"));
    return null;
  }
  return targetPath;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync(BOUNDARY_GIT_EXECUTABLE_PATH, args, {
    cwd: root,
    encoding: "utf8",
    env: boundaryGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function diagnostic(
  kind: DiagnosticKind,
  code: string,
  path: string,
  message: string,
  offset: number | null = null,
): BoundaryDiagnostic {
  return { kind, code, path: posixPath(path), message, offset };
}

function uniqueDiagnostics(items: readonly BoundaryDiagnostic[]): BoundaryDiagnostic[] {
  const seen = new Set<string>();
  const result: BoundaryDiagnostic[] = [];
  for (const item of items) {
    const key = `${item.kind}|${item.code}|${item.path}|${item.offset ?? ""}|${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result.sort((a, b) =>
    `${a.path}:${a.offset ?? -1}:${a.code}`.localeCompare(`${b.path}:${b.offset ?? -1}:${b.code}`));
}

export function classifyBoundaryPathV1(path: string): { language: Language; fileClass: FileClass; sourceLike: boolean } {
  const normalized = posixPath(path);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extension = extname(base).toLowerCase();
  const language = SOURCE_EXTENSIONS.get(extension) ?? "metadata";
  const parts = normalized.split("/");
  const top = parts[0] ?? "";
  const generatedMetadata = normalized === CATALOG_INPUT_PATH
    || normalized === CATALOG_LEDGER_PATH
    || normalized === CATALOG_TSCONFIG_PATH;
  const generated = !generatedMetadata
    && (parts.includes("generated") || /(?:^|\.)(?:generated|gen)\.[^.]+$/.test(base));
  let fileClass: FileClass;
  if (generated) fileClass = "generated";
  else if (top === "acceptance") fileClass = parts[1] === "collectors" ? "acceptance-collector" : "acceptance-pure-core";
  else if (top === "families") fileClass = "family";
  else if (top === "valuation-owners") fileClass = "valuation-owner";
  else if (top === "apps" || top === "contracts" || top === "runtime") fileClass = "production-runtime";
  else if (top === "tools" && parts[1] === "reference-only") fileClass = "reference-only";
  else if (top === "tools") fileClass = "authoring";
  else if (top === "strategies") fileClass = "strategy";
  else if (FROZEN_PURE_CORE_PATHS.has(normalized)) fileClass = "acceptance-pure-core";
  else if (top === "packages" || top === "specs") fileClass = "central";
  else if (top === "docs" || top === "analysis") fileClass = "metadata";
  else fileClass = "metadata";
  const sourceLike = SOURCE_EXTENSIONS.has(extension) || CONFIG_NAMES.has(base);
  return { language, fileClass, sourceLike };
}

/**
 * Test/compiler fixtures are valid denominator inputs, but never valid
 * production release inputs.  Keep this path predicate independent from the
 * compiler graph: a fixture that is accidentally pulled into a production
 * closure must be rejected even when its import edge is hidden behind a
 * generated or package entrypoint.
 */
function isTestOrFixturePath(path: string): boolean {
  const normalized = posixPath(path);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return /(?:^|\/)(?:test|tests|fixture|fixtures)\//.test(normalized) ||
    /(?:^|\.)test\.[^.]+$/.test(normalized) ||
    /(?:^|\.)spec\.[^.]+$/.test(normalized) ||
    /(?:^|[-_.])(?:test|tests|fixture|fixtures)(?:[-_.]|$)/.test(base);
}

function readTrackedFiles(root: string, diagnostics: BoundaryDiagnostic[]): TrackedFile[] {
  let output: string;
  let flagOutput: string;
  try {
    output = execFileSync(BOUNDARY_GIT_EXECUTABLE_PATH, ["ls-files", "-s", "-z"], {
      cwd: root,
      encoding: "utf8",
      env: boundaryGitEnvironment(),
    });
    flagOutput = execFileSync(BOUNDARY_GIT_EXECUTABLE_PATH, ["ls-files", "-v", "-z"], {
      cwd: root,
      encoding: "utf8",
      env: boundaryGitEnvironment(),
    });
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "git-tree-unreadable", ".", String(error)));
    return [];
  }
  const indexFlags = new Map<string, string>();
  for (const record of flagOutput.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf(" ");
    if (separator !== 1) {
      diagnostics.push(diagnostic("invalid", "git-index-flag-record", ".", "Malformed git ls-files -v record"));
      continue;
    }
    indexFlags.set(posixPath(record.slice(2)), record[0]!);
  }
  const files: TrackedFile[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) {
      diagnostics.push(diagnostic("invalid", "git-index-record", ".", "Malformed git ls-files record"));
      continue;
    }
    const [mode, blobSha, stage] = record.slice(0, tab).split(/\s+/);
    const path = posixPath(record.slice(tab + 1));
    if (stage !== "0") {
      diagnostics.push(diagnostic("invalid", "nonzero-index-stage", path, "Unmerged index entries cannot enter the source denominator"));
    }
    if (indexFlags.get(path) !== "H") {
      diagnostics.push(diagnostic("invalid", "noncanonical-index-flag", path, "assume-unchanged, skip-worktree, or another nonstandard index flag is forbidden"));
    }
    if (mode === "120000") {
      diagnostics.push(diagnostic("invalid", "symlink-in-denominator", path, "Symlinks are not a reproducible source denominator"));
    }
    const metadata = classifyBoundaryPathV1(path);
    const filePath = abs(root, path);
    let byteLength = 0;
    let contentSha256 = "";
    try {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        diagnostics.push(diagnostic("invalid", "symlink-in-denominator", path, "Working tree path is a symlink"));
      } else if (!stat.isFile()) {
        diagnostics.push(diagnostic("invalid", "tracked-path-not-file", path, "Tracked denominator entry is not a regular file"));
      } else {
        const bytes = readFileSync(filePath);
        byteLength = bytes.byteLength;
        contentSha256 = `0x${createHash("sha256").update(bytes).digest("hex")}`;
        const indexedBytes = execFileSync(BOUNDARY_GIT_EXECUTABLE_PATH, ["cat-file", "blob", blobSha], {
          cwd: root,
          encoding: null,
          env: boundaryGitEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (!bytes.equals(indexedBytes)) {
          diagnostics.push(diagnostic("invalid", "worktree-index-content-mismatch", path, "Compiler-visible bytes differ from the exact indexed blob"));
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "tracked-file-missing", path, String(error)));
    }
    const extension = extname(path).toLowerCase();
    const sourceRoot = path.includes("/") ? path.slice(0, path.indexOf("/")) : null;
    const sourceDirectory = /^(acceptance|apps|contracts|families|generated|packages|specs|strategies|tools|runtime|valuation-owners)\//.test(path);
    const configLike = CONFIG_NAMES.has(path.slice(path.lastIndexOf("/") + 1));
    if ((metadata.language === "typescript" || metadata.language === "javascript" || configLike) && sourceRoot !== null && !DECLARED_SOURCE_ROOTS.has(sourceRoot)) {
      diagnostics.push(diagnostic("invalid", "unknown-source-root", path, "Source files must live under a declared repository source root"));
    }
    if (sourceDirectory && !metadata.sourceLike && !METADATA_NAMES.has(path.slice(path.lastIndexOf("/") + 1)) && !METADATA_EXTENSIONS.has(extension)) {
      diagnostics.push(diagnostic("invalid", "unclassified-source-file", path, "File in a source root has no declared language/class"));
    }
    files.push({ path, mode, blobSha, contentSha256, byteLength, language: metadata.language, fileClass: metadata.fileClass });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readJson(root: string, path: string, diagnostics: BoundaryDiagnostic[]): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(abs(root, path), "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("object expected");
    return value as Record<string, unknown>;
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "invalid-json-manifest", path, String(error)));
    return null;
  }
}

function getStringTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(getStringTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(getStringTargets);
  return [];
}

interface PackageEntrypoint {
  readonly id: string;
  readonly path: string;
  readonly packageName: string | null;
  readonly manifestPath: string;
  readonly subpath: string;
}

function packageExportTargets(value: unknown, subpath: string, result: Array<{ subpath: string; target: string }>): void {
  if (typeof value === "string") {
    if (value.startsWith("./")) result.push({ subpath, target: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) packageExportTargets(item, subpath, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith(".")) packageExportTargets(item, key, result);
    else packageExportTargets(item, subpath, result);
  }
}

function publicPackageTargets(value: Record<string, unknown>): Array<{ subpath: string; target: string }> {
  const result: Array<{ subpath: string; target: string }> = [];
  const hasExports = Object.prototype.hasOwnProperty.call(value, "exports");
  if (hasExports) {
    packageExportTargets(value.exports, ".", result);
  } else {
    for (const field of ["main", "module", "types", "typings"] as const) {
      const target = value[field];
      if (typeof target === "string" && target.startsWith("./")) result.push({ subpath: `#${field}`, target });
    }
  }
  const bin = value.bin;
  if (typeof bin === "string" && bin.startsWith("./")) {
    result.push({ subpath: "#bin", target: bin });
  } else if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) {
    for (const [name, target] of Object.entries(bin).sort(([left], [right]) => left.localeCompare(right))) {
      if (typeof target === "string" && target.startsWith("./")) {
        result.push({ subpath: `#bin:${name}`, target });
      }
    }
  }
  return result;
}

function readPackageManifests(
  root: string,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): { manifests: Map<string, Record<string, unknown>>; workspaceNames: string[]; rootHash: string; entrypoints: PackageEntrypoint[] } {
  const manifests = new Map<string, Record<string, unknown>>();
  const packageFiles = files.filter((file) => file.path.endsWith("/package.json") || file.path === "package.json");
  const entrypoints: PackageEntrypoint[] = [];
  for (const file of packageFiles) {
    const value = readJson(root, file.path, diagnostics);
    if (value) manifests.set(file.path, value);
  }
  const workspaceNames: string[] = [];
  const rootManifest = manifests.get("package.json");
  const workspacePatterns = Array.isArray(rootManifest?.workspaces)
    ? rootManifest.workspaces.filter((item): item is string => typeof item === "string")
    : typeof rootManifest?.workspaces === "object" && rootManifest.workspaces !== null && Array.isArray((rootManifest.workspaces as Record<string, unknown>).packages)
      ? ((rootManifest.workspaces as Record<string, unknown>).packages as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
  const matches = (path: string, pattern: string): boolean => {
    const p = pattern.replace(/\*\*/g, "§§").replace(/\*/g, "[^/]+").replace(/§§/g, ".*");
    return new RegExp(`^${p}$`).test(path);
  };
  for (const [path, value] of manifests) {
    const packageDir = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
    if (packageDir && workspacePatterns.length > 0 && !workspacePatterns.some((pattern) => matches(packageDir, pattern))) {
      diagnostics.push(diagnostic("fail", "workspace-package-outside-workspaces", path, "Package is not covered by the root workspaces declaration"));
    }
    if (typeof value.name === "string") workspaceNames.push(value.name);
    for (const field of ["exports", "imports"] as const) {
      for (const target of getStringTargets(value[field])) {
        if (!target.startsWith("./")) continue;
        const targetPath = posixPath(join(packageDir, target));
        const targetMatches = targetPath.endsWith("*")
          ? files.some((candidate) => candidate.path.startsWith(targetPath.slice(0, -1)))
          : files.some((candidate) => candidate.path === targetPath);
        if (!targetMatches) {
          diagnostics.push(diagnostic("fail", "package-target-not-tracked", path, `${field} target ${target} is not in the exact Git tree`));
        }
      }
    }
    if (value) {
      const packageDir = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
      for (const target of publicPackageTargets(value)) {
        const targetPath = posixPath(join(packageDir, target.target));
        if (target.target.includes("*")) {
          diagnostics.push(diagnostic("invalid", "package-entrypoint-wildcard", path, `Public package entrypoint ${target.subpath} contains an unresolved wildcard`));
          continue;
        }
        const candidate = files.find((item) => item.path === targetPath);
        if (!candidate) {
          diagnostics.push(diagnostic("invalid", "package-entrypoint-not-tracked", path, `Public package entrypoint ${target.subpath} target ${target.target} is not in the exact Git tree`));
          continue;
        }
        if (candidate.language !== "typescript" && candidate.language !== "javascript") {
          diagnostics.push(diagnostic("invalid", "package-entrypoint-not-source", path, `Public package entrypoint ${target.subpath} target ${target.target} is not a tracked TS/JS source`));
          continue;
        }
        entrypoints.push({
          id: `package-entrypoint:${path}:${target.subpath}:${targetPath}`,
          path: targetPath,
          packageName: typeof value.name === "string" ? value.name : null,
          manifestPath: path,
          subpath: target.subpath,
        });
      }
    }
  }
  const rootHash = hashDomain("aloha/boundary/package-manifests/v1", packageFiles.map((file) => ({ path: file.path, sha: file.blobSha })));
  const uniqueEntrypoints = Array.from(new Map(entrypoints.map((entry) => [entry.id, entry])).values())
    .sort((a, b) => a.id.localeCompare(b.id));
  return { manifests, workspaceNames: workspaceNames.sort(), rootHash, entrypoints: uniqueEntrypoints };
}

interface NpmLockRecordFacts {
  readonly path: string;
  readonly version: string | null;
  readonly recordHash: string;
}

interface NpmLockFacts {
  readonly records: ReadonlyMap<string, NpmLockRecordFacts>;
}

function readNpmLockFacts(
  root: string,
  lockFiles: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): NpmLockFacts {
  const rootLocks = lockFiles.filter((file) => file.path === "package-lock.json" || file.path === "npm-shrinkwrap.json");
  if (rootLocks.length !== 1) {
    diagnostics.push(diagnostic("invalid", "npm-lock-root-ambiguous", ".", "Exactly one tracked root package-lock.json or npm-shrinkwrap.json is required for TypeScript external compiler inputs"));
    return { records: new Map() };
  }
  const value = readJson(root, rootLocks[0]!.path, diagnostics);
  const packages = value?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    diagnostics.push(diagnostic("invalid", "npm-lock-packages-missing", rootLocks[0]!.path, "npm lockfile v2/v3 packages map is required for external compiler inputs"));
    return { records: new Map() };
  }
  const records = new Map<string, NpmLockRecordFacts>();
  for (const [path, raw] of Object.entries(packages as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.push(diagnostic("invalid", "npm-lock-record-invalid", rootLocks[0]!.path, `Lock record ${path} must be an object`));
      continue;
    }
    const record = raw as Record<string, unknown>;
    records.set(posixPath(path), {
      path: posixPath(path),
      version: typeof record.version === "string" ? record.version : null,
      recordHash: hashDomain("aloha/boundary/npm-lock-record/v1", { path: posixPath(path), record }),
    });
  }
  return { records };
}

interface ConfigChainFacts {
  readonly chain: ImplementationConfigChain;
  readonly root: string;
  readonly hasProjectReferences: boolean;
}

function resolveExtendedConfigPath(
  root: string,
  fromPath: string,
  specifier: string,
  tracked: ReadonlyMap<string, TrackedFile>,
  diagnostics: BoundaryDiagnostic[],
): string | null {
  const fromAbsolute = abs(root, fromPath);
  const candidates: string[] = [];
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const candidate = resolve(dirname(fromAbsolute), specifier);
    candidates.push(candidate, `${candidate}.json`, join(candidate, "tsconfig.json"));
  } else {
    const resolved = ts.resolveModuleName(specifier, fromAbsolute, {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }, ts.sys).resolvedModule?.resolvedFileName;
    if (resolved) candidates.push(resolve(resolved));
  }
  for (const candidate of candidates) {
    if (!ts.sys.fileExists(candidate)) continue;
    if (!isInside(root, candidate)) {
      diagnostics.push(diagnostic("invalid", "tsconfig-extends-outside-root", fromPath, `Extended config ${specifier} resolves outside the exact repository root`));
      return null;
    }
    const targetPath = rel(root, candidate);
    if (!tracked.has(targetPath)) {
      diagnostics.push(diagnostic("invalid", "tsconfig-extends-not-tracked", targetPath, "Every extended tsconfig must be present in the exact Git denominator"));
      return null;
    }
    return targetPath;
  }
  diagnostics.push(diagnostic("invalid", "tsconfig-extends-unresolved", fromPath, `Cannot resolve extended config ${specifier}`));
  return null;
}

function readConfigChain(
  root: string,
  configPath: string,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): ConfigChainFacts {
  const tracked = new Map(files.map((file) => [file.path, file]));
  const chainFiles = new Map<string, ImplementationClosureFile>();
  const chainEdges: GraphEdge[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let hasProjectReferences = false;
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    if (visiting.has(path)) {
      diagnostics.push(diagnostic("invalid", "tsconfig-extends-cycle", path, "Extended tsconfig chain contains a cycle"));
      return;
    }
    const file = tracked.get(path);
    if (!file) {
      diagnostics.push(diagnostic("invalid", "tsconfig-not-tracked", path, "Every compiler config must be present in the exact Git denominator"));
      return;
    }
    visiting.add(path);
    chainFiles.set(path, { path: file.path, blobSha: file.blobSha, contentSha256: file.contentSha256, byteLength: file.byteLength });
    const loaded = ts.readConfigFile(abs(root, path), ts.sys.readFile);
    if (loaded.error || !loaded.config || typeof loaded.config !== "object" || Array.isArray(loaded.config)) {
      diagnostics.push(diagnostic("invalid", "tsconfig-read-error", path, loaded.error ? ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n") : "Config object expected"));
      visiting.delete(path);
      visited.add(path);
      return;
    }
    const raw = loaded.config as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(raw, "references")) hasProjectReferences = true;
    const extended = raw.extends;
    if (extended !== undefined) {
      if (typeof extended !== "string") {
        diagnostics.push(diagnostic("invalid", "tsconfig-extends-type", path, "tsconfig extends must be one string path"));
      } else {
        const target = resolveExtendedConfigPath(root, path, extended, tracked, diagnostics);
        if (target) {
          chainEdges.push({ from: path, to: target, specifier: extended });
          visit(target);
        }
      }
    }
    visiting.delete(path);
    visited.add(path);
  };
  visit(configPath);
  const chain: ImplementationConfigChain = {
    rootPath: configPath,
    files: Array.from(chainFiles.values()).sort((a, b) => a.path.localeCompare(b.path)),
    edges: Array.from(new Map(chainEdges.map((edge) => [`${edge.from}|${edge.to}|${edge.specifier}`, edge])).values())
      .sort((a, b) => `${a.from}|${a.to}|${a.specifier}`.localeCompare(`${b.from}|${b.to}|${b.specifier}`)),
  };
  return {
    chain,
    root: hashDomain("aloha/boundary/tsconfig-chain/v1", chain),
    hasProjectReferences,
  };
}

function readTsConfig(
  root: string,
  configPath: string,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): { parsed: ts.ParsedCommandLine; program: ts.Program; configChain: ConfigChainFacts } | null {
  const configChain = readConfigChain(root, configPath, files, diagnostics);
  const absolute = abs(root, configPath);
  const loaded = ts.readConfigFile(absolute, ts.sys.readFile);
  if (loaded.error) {
    diagnostics.push(diagnostic("invalid", "tsconfig-read-error", configPath, ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n")));
    return null;
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(absolute), undefined, absolute);
  for (const error of parsed.errors) {
    diagnostics.push(diagnostic("invalid", "tsconfig-parse-error", configPath, ts.flattenDiagnosticMessageText(error.messageText, "\n")));
  }
  if (parsed.options.moduleResolution !== ts.ModuleResolutionKind.NodeNext || parsed.options.module !== ts.ModuleKind.NodeNext) {
    diagnostics.push(diagnostic("fail", "non-nodenext-resolution", configPath, "The production TypeScript graph must use the pinned NodeNext resolver"));
  }
  const disabledDenominatorOptions = [
    ["noLib", parsed.options.noLib],
    ["skipLibCheck", parsed.options.skipLibCheck],
    ["skipDefaultLibCheck", parsed.options.skipDefaultLibCheck],
  ] as const;
  for (const [option, enabled] of disabledDenominatorOptions) {
    if (enabled === true) {
      diagnostics.push(diagnostic(
        "invalid",
        "compiler-denominator-disabled",
        configPath,
        `Compiler option ${option}=true removes diagnostics or inputs from the qualified production compiler denominator`,
      ));
    }
  }
  if (configChain.hasProjectReferences || parsed.projectReferences && parsed.projectReferences.length > 0) {
    diagnostics.push(diagnostic("invalid", "project-references-unsupported", configPath, "Project references are not part of the qualified compiler closure adapter"));
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  for (const error of ts.getPreEmitDiagnostics(program)) {
    const file = error.file ? rel(root, error.file.fileName) : configPath;
    diagnostics.push(diagnostic("fail", "typescript-build-diagnostic", file, ts.flattenDiagnosticMessageText(error.messageText, "\n"), error.start ?? null));
  }
  return { parsed, program, configChain };
}

function compilerOptionsForDigest(
  root: string,
  options: ts.CompilerOptions,
  configPath: string,
  diagnostics: BoundaryDiagnostic[],
): unknown {
  const normalize = (value: unknown, keyPath: string): unknown => {
    if (typeof value === "string") {
      if (!isAbsolute(value)) return value;
      if (!isInside(root, value)) {
        diagnostics.push(diagnostic("invalid", "compiler-option-path-outside-root", configPath, `Compiler option ${keyPath} contains an absolute path outside the exact repository root`));
        return "@outside-root";
      }
      return `@repo/${rel(root, value)}`;
    }
    if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${keyPath}[${index}]`));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item, keyPath ? `${keyPath}.${key}` : key)]));
    }
    return value;
  };
  return normalize({ ...options, configFilePath: configPath }, "compilerOptions");
}

function moduleSpecifierText(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function unwrapped(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  return value;
}

function isIdentifierNamed(expression: ts.Expression, names: ReadonlySet<string>): boolean {
  const value = unwrapped(expression);
  return ts.isIdentifier(value) && names.has(value.text);
}

function isImportCall(expression: ts.Expression): boolean {
  const value = unwrapped(expression);
  return value.kind === ts.SyntaxKind.ImportKeyword;
}

export interface SourceScanOptions {
  readonly pureAcceptanceCore?: boolean;
  /** Runtime/central/family source may not spawn child processes. */
  readonly forbidEnvironmentIo?: boolean;
  /** Tests and authoring tools are outside the production import closure. */
  readonly allowDynamicLoaders?: boolean;
  /** The one deployment shell may load an externally packaged, absolute bundle. */
  readonly allowExternalDeploymentBundleLoader?: boolean;
}

export interface SourceScanResult {
  readonly diagnostics: BoundaryDiagnostic[];
  readonly imports: Array<{ specifier: string; offset: number; dynamic: boolean }>;
}

const PURE_ACCEPTANCE_FORBIDDEN_MODULES = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises", "path", "node:path", "url", "node:url",
  "net", "node:net", "http", "node:http", "https", "node:https", "dns", "node:dns",
  "tls", "node:tls", "child_process", "node:child_process", "worker_threads", "node:worker_threads",
]);

/** AST-only loader scan. It is also used by independent mutation tests. */
export function inspectSourceText(path: string, source: string, options: SourceScanOptions = {}): SourceScanResult {
  const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : undefined;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics: BoundaryDiagnostic[] = [];
  const imports: Array<{ specifier: string; offset: number; dynamic: boolean }> = [];
  const hasPathToFileUrlImport = file.statements.some((statement) => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === "node:url"
    && statement.importClause?.namedBindings !== undefined
    && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((element) =>
      (element.propertyName?.text ?? element.name.text) === "pathToFileURL"
      && element.name.text === "pathToFileURL"));
  const requireNames = new Set(["require"]);
  const createRequireNames = new Set<string>(["createRequire"]);
  const workerNames = new Set(["Worker"]);
  const childProcessNames = new Set<string>();
  const report = (code: string, node: ts.Node, message: string, kind: DiagnosticKind = "fail") => {
    diagnostics.push(diagnostic(kind, code, path, message, node.getStart(file)));
  };
  const addBinding = (name: ts.BindingName, set: Set<string>) => {
    if (ts.isIdentifier(name)) set.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) addBinding(element.name, set);
  };
  const isCreateRequireCall = (expression: ts.Expression): boolean => {
    const value = unwrapped(expression);
    return ts.isCallExpression(value) && isIdentifierNamed(value.expression, createRequireNames);
  };
  const isRequireAlias = (expression: ts.Expression): boolean => isIdentifierNamed(expression, requireNames);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier === null) report("nonliteral-module-specifier", node.moduleSpecifier, "Import specifier must be a literal");
      else {
        imports.push({ specifier, offset: node.moduleSpecifier.getStart(file), dynamic: false });
        if (options.forbidEnvironmentIo && (specifier === "node:child_process" || specifier === "child_process")) report("child-process-loader", node.moduleSpecifier, "child_process is outside the production boundary");
        if (options.pureAcceptanceCore && PURE_ACCEPTANCE_FORBIDDEN_MODULES.has(specifier)) report("acceptance-environment-import", node.moduleSpecifier, "Acceptance pure core cannot import filesystem, process, network, child-process, or worker APIs");
        if (specifier === "node:worker_threads" || specifier === "worker_threads") {
          for (const element of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : []) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === "Worker") workerNames.add(element.name.text);
          }
        }
        for (const element of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : []) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "createRequire" && (specifier === "node:module" || specifier === "module")) createRequireNames.add(element.name.text);
        }
        if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings) && (specifier === "node:worker_threads" || specifier === "worker_threads")) workerNames.add(`${node.importClause.namedBindings.name.text}.Worker`);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier === null) report("nonliteral-module-specifier", node.moduleSpecifier, "Export specifier must be a literal");
      else imports.push({ specifier, offset: node.moduleSpecifier.getStart(file), dynamic: false });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = moduleSpecifierText(node.moduleReference.expression!);
      if (specifier === null) report("nonliteral-module-specifier", node.moduleReference, "Import-equals specifier must be a literal");
      else imports.push({ specifier, offset: node.moduleReference.getStart(file), dynamic: false });
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (isRequireAlias(node.initializer)) {
        report("ambiguous-loader-alias", node.initializer, "Cannot prove a require alias dataflow; use a static import");
      }
      const initializer = unwrapped(node.initializer);
      if (ts.isCallExpression(initializer) && isIdentifierNamed(initializer.expression, requireNames)) {
        const requiredModule = initializer.arguments[0] ? moduleSpecifierText(initializer.arguments[0]) : null;
        if (requiredModule === "node:module" || requiredModule === "module") {
          if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
              if (imported === "createRequire") addBinding(element.name, createRequireNames);
            }
          }
        }
      }
      if (isCreateRequireCall(node.initializer)) {
        addBinding(node.name, requireNames);
        addBinding(node.name, createRequireNames);
      }
      if (ts.isIdentifier(node.name) && isIdentifierNamed(node.initializer, workerNames)) workerNames.add(node.name.text);
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(unwrapped(node.initializer))) {
        const property = unwrapped(node.initializer) as ts.PropertyAccessExpression;
        if (property.name.text === "Worker") workerNames.add(node.name.text);
      }
      if (ts.isIdentifier(node.name) && isCreateRequireCall(node.initializer)) createRequireNames.add(node.name.text);
      if (ts.isIdentifier(node.initializer) && (node.initializer.text === "eval" || node.initializer.text === "Function")) {
        report("ambiguous-dynamic-code-alias", node.initializer, "Cannot prove an eval/Function alias is safe; use static code");
      }
    }
    if (options.pureAcceptanceCore && ts.isIdentifier(node) && node.text === "process") {
      report("acceptance-environment-process", node, "Acceptance pure core cannot read process/environment state");
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrapped(node.expression);
      if (isImportCall(expression)) {
        const argument = node.arguments[0];
        const specifier = argument ? moduleSpecifierText(argument) : null;
        const deploymentArgument = argument === undefined ? null : unwrapped(argument);
        const deploymentProperty = deploymentArgument !== null && ts.isPropertyAccessExpression(deploymentArgument)
          ? deploymentArgument
          : null;
        const deploymentCall = deploymentProperty !== null && ts.isCallExpression(deploymentProperty.expression)
          ? deploymentProperty.expression
          : null;
        const isDeploymentBundleLoader = path === EXTERNAL_DEPLOYMENT_LOADER_PATH
          && options.allowExternalDeploymentBundleLoader === true
          && hasPathToFileUrlImport
          && deploymentProperty !== null
          && deploymentProperty.name.text === "href"
          && deploymentCall !== null
          && ts.isIdentifier(deploymentCall.expression)
          && deploymentCall.expression.text === "pathToFileURL"
          && deploymentCall.arguments.length === 1
          && ts.isIdentifier(deploymentCall.arguments[0])
          && deploymentCall.arguments[0].text === "path";
        if (specifier === null && !isDeploymentBundleLoader) report("dynamic-import-nonliteral", argument ?? node, "Dynamic import must use one literal module specifier");
        else if (specifier !== null) imports.push({ specifier, offset: argument.getStart(file), dynamic: true });
      } else if (ts.isCallExpression(expression) && isIdentifierNamed(expression.expression, createRequireNames)) {
        const argument = node.arguments[0];
        const specifier = argument ? moduleSpecifierText(argument) : null;
        if (specifier === null) report("dynamic-loader", argument ?? node, "createRequire loader must use a literal specifier");
        else imports.push({ specifier, offset: argument.getStart(file), dynamic: false });
      } else if (isIdentifierNamed(expression, requireNames)) {
        const argument = node.arguments[0];
        const specifier = argument ? moduleSpecifierText(argument) : null;
        if (specifier === null) report("dynamic-loader", argument ?? node, "require/createRequire loader must use a literal specifier");
        else {
          if (options.forbidEnvironmentIo && (specifier === "node:child_process" || specifier === "child_process")) report("child-process-loader", argument, "child_process is outside the production boundary");
          imports.push({ specifier, offset: argument.getStart(file), dynamic: false });
        }
      } else if (isIdentifierNamed(expression, createRequireNames)) {
        // createRequire(import.meta.url) creates a loader; only calls made
        // through that loader are subject to the literal-specifier rule.
      } else if (ts.isIdentifier(expression) && (expression.text === "eval" || expression.text === "Function")) {
        report("dynamic-code-eval", expression, "eval and Function are not permitted in the source/build boundary");
      } else if (options.pureAcceptanceCore && ts.isIdentifier(expression) && (expression.text === "fetch" || expression.text === "WebSocket" || expression.text === "XMLHttpRequest")) {
        report("acceptance-environment-network", expression, "Acceptance pure core cannot perform network I/O");
      }
      const property = ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      if (property && childProcessNames.has(property)) report("child-process-loader", expression, "child_process execution is outside the production boundary");
    }
    if (ts.isNewExpression(node)) {
      const expression = unwrapped(node.expression);
      const worker = ts.isIdentifier(expression) && workerNames.has(expression.text)
        || ts.isPropertyAccessExpression(expression) && workerNames.has(`${expression.expression.getText(file)}.${expression.name.text}`)
        || ts.isIdentifier(expression) && expression.text === "Worker";
      if (worker) {
        const argument = node.arguments?.[0];
        if (!argument || moduleSpecifierText(argument) === null) report("worker-nonliteral", argument ?? node, "Worker entry must be a literal and must resolve through NodeNext");
        else imports.push({ specifier: moduleSpecifierText(argument)!, offset: argument.getStart(file), dynamic: false });
      }
      if (ts.isIdentifier(expression) && expression.text === "Function") report("dynamic-code-eval", expression, "Function constructor is not permitted");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const dynamicLoaderCodes = new Set([
    "ambiguous-loader-alias",
    "dynamic-loader",
    "dynamic-import-nonliteral",
    "worker-nonliteral",
    "dynamic-code-eval",
  ]);
  return {
    diagnostics: options.allowDynamicLoaders ? diagnostics.filter((item) => !dynamicLoaderCodes.has(item.code)) : diagnostics,
    imports,
  };
}

function resolveSpecifier(
  root: string,
  containingPath: string,
  specifier: string,
  options: ts.CompilerOptions,
  tracked: ReadonlyMap<string, TrackedFile>,
  externalDependencies: Set<string>,
  diagnostics: BoundaryDiagnostic[],
  offset: number,
  resolutionMode?: ts.ResolutionMode,
  programResolution?: ts.ResolvedModuleWithFailedLookupLocations,
): string | null {
  const repositoryRoot = resolve(realpathSync(root));
  if (NODE_BUILTIN_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    externalDependencies.add(specifier);
    return `@external/${specifier}`;
  }
  const result = programResolution === undefined
    ? ts.resolveModuleName(specifier, containingPath, options, ts.sys, undefined, undefined, resolutionMode).resolvedModule
    : programResolution.resolvedModule;
  const resolvedFileName = result?.resolvedFileName;
  if (!resolvedFileName) {
    diagnostics.push(diagnostic("invalid", "unresolved-module", rel(root, containingPath), `NodeNext could not resolve ${specifier}`, offset));
    return null;
  }
  const target = resolve(resolvedFileName);
  let physicalTarget: string;
  try {
    physicalTarget = resolve(realpathSync(target));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "resolved-file-unreadable", rel(root, containingPath), String(error), offset));
    return null;
  }
  if (!isInside(repositoryRoot, physicalTarget)) {
    if (target.includes(`${sep}node_modules${sep}`) || physicalTarget.includes(`${sep}node_modules${sep}`)) {
      externalDependencies.add(specifier);
      return `@external/${specifier}`;
    }
    diagnostics.push(diagnostic("invalid", "resolved-outside-root", rel(root, containingPath), `Resolved module ${specifier} is outside the exact repository root`, offset));
    return null;
  }
  const targetPath = rel(repositoryRoot, physicalTarget);
  if (targetPath.startsWith("node_modules/")) {
    externalDependencies.add(specifier);
    return `@external/${specifier}`;
  }
  const file = tracked.get(targetPath);
  if (!file) diagnostics.push(diagnostic("invalid", "resolved-file-not-tracked", targetPath, `Resolved module ${specifier} is outside the exact Git denominator`, offset));
  if (file?.mode === "120000") diagnostics.push(diagnostic("invalid", "resolved-symlink", targetPath, "Resolved module is a symlink", offset));
  return file ? targetPath : null;
}

function resolveTypeReference(
  root: string,
  containingPath: string,
  typeName: string,
  options: ts.CompilerOptions,
  tracked: ReadonlyMap<string, TrackedFile>,
  externalDependencies: Set<string>,
  diagnostics: BoundaryDiagnostic[],
  offset: number,
): string | null {
  const repositoryRoot = resolve(realpathSync(root));
  const result = ts.resolveTypeReferenceDirective(typeName, containingPath, options, ts.sys).resolvedTypeReferenceDirective;
  if (!result) {
    diagnostics.push(diagnostic("invalid", "unresolved-type-reference", rel(root, containingPath), `NodeNext could not resolve type reference ${typeName}`, offset));
    return null;
  }
  const resolvedFileName = result.resolvedFileName;
  if (!resolvedFileName) {
    diagnostics.push(diagnostic("invalid", "unresolved-type-reference", rel(root, containingPath), `NodeNext could not resolve type reference ${typeName}`, offset));
    return null;
  }
  const target = resolve(resolvedFileName);
  let physicalTarget: string;
  try {
    physicalTarget = resolve(realpathSync(target));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "resolved-type-reference-unreadable", rel(root, containingPath), String(error), offset));
    return null;
  }
  if (!isInside(repositoryRoot, physicalTarget)) {
    if (target.includes(`${sep}node_modules${sep}`) || physicalTarget.includes(`${sep}node_modules${sep}`)) {
      externalDependencies.add(typeName);
      return `@external/${typeName}`;
    }
    diagnostics.push(diagnostic("invalid", "resolved-outside-root", rel(root, containingPath), `Resolved type reference ${typeName} is outside the exact repository root`, offset));
    return null;
  }
  const targetPath = rel(repositoryRoot, physicalTarget);
  if (targetPath.startsWith("node_modules/")) {
    externalDependencies.add(typeName);
    return `@external/${typeName}`;
  }
  const file = tracked.get(targetPath);
  if (!file) diagnostics.push(diagnostic("invalid", "resolved-file-not-tracked", targetPath, `Resolved type reference ${typeName} is outside the exact Git denominator`, offset));
  if (file?.mode === "120000") diagnostics.push(diagnostic("invalid", "resolved-symlink", targetPath, "Resolved type reference is a symlink", offset));
  return file ? targetPath : null;
}

/**
 * GateCore has one public authority entrypoint. Do not recursively accept
 * package export conditions here: a conditional/deep export would create a
 * second runtime surface outside the generated release wrapper.
 */
export function validateGateCorePackageExports(
  packagePath: string,
  value: Record<string, unknown>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const rawExports = value.exports;
  const isExactExportMap = rawExports !== null &&
    typeof rawExports === "object" &&
    !Array.isArray(rawExports) &&
    Object.keys(rawExports as Record<string, unknown>).length === 1 &&
    Object.prototype.hasOwnProperty.call(rawExports, ".") &&
    (rawExports as Record<string, unknown>)["."] === GATE_CORE_RELEASE_TARGET;
  if (!isExactExportMap) {
    diagnostics.push(diagnostic(
      "fail",
      "gate-core-package-exports",
      packagePath,
      `GateCore package exports must be exactly {".": "${GATE_CORE_RELEASE_TARGET}"}; conditional, array, deep, or alternate exports are forbidden`,
    ));
  }
}

function validateReleaseGeneratedTree(
  root: string,
  files: readonly TrackedFile[],
  generated: readonly TrackedFile[],
  requireReleaseTree: boolean,
  diagnostics: BoundaryDiagnostic[],
): Set<string> {
  const generatorPaths = new Set<string>();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const presentOutputs = generated
    .map((file) => file.path)
    .filter((path) => RELEASE_GENERATED_OUTPUT_PATHS.includes(path))
    .sort();
  const presentFixedOutputs = files
    .map((file) => file.path)
    .filter((path) => RELEASE_FIXED_OUTPUT_PATHS.includes(path))
    .sort();
  const ledgerFile = byPath.get(RELEASE_LEDGER_PATH);
  const productionReleaseTree = ledgerFile !== undefined ||
    presentOutputs.includes("acceptance/gate-core/src/generated/release-role-manifest.ts") ||
    (byPath.has("acceptance/gate-core/package.json") && presentOutputs.includes(RELEASE_RUNTIME_PATH));
  if (!productionReleaseTree && !requireReleaseTree) return generatorPaths;
  if (canonical(presentOutputs) !== canonical(RELEASE_GENERATED_OUTPUT_PATHS) || canonical(presentFixedOutputs) !== canonical(RELEASE_FIXED_OUTPUT_PATHS)) {
    diagnostics.push(diagnostic("invalid", "release-generated-output-set", RELEASE_LEDGER_PATH, "Release generation must own the exact authority, predicate composition, role manifest, and public runtime output set"));
  }
  if (ledgerFile === undefined) {
    diagnostics.push(diagnostic("invalid", "release-generation-ledger-missing", RELEASE_LEDGER_PATH, "Release generated outputs require the fixed content-addressed regeneration ledger"));
    return generatorPaths;
  }
  const ledger = readJson(root, RELEASE_LEDGER_PATH, diagnostics);
  if (ledger !== null) {
    const rawOutputs = Array.isArray(ledger.outputs) ? ledger.outputs : [];
    const outputPaths = rawOutputs.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      return typeof record.path === "string" ? record.path : null;
    });
    if (outputPaths.some((path) => path === null) || canonical(outputPaths.filter((path): path is string => path !== null).sort()) !== canonical(RELEASE_GENERATED_OUTPUT_PATHS)) {
      diagnostics.push(diagnostic("invalid", "release-generation-ledger-output-set", RELEASE_LEDGER_PATH, "Release ledger must bind the exact fixed generated output set"));
    }
    for (const raw of rawOutputs) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.path !== "string") continue;
      const file = byPath.get(record.path);
      if (!file || record.contentSha256 !== file.contentSha256 || record.byteLength !== file.byteLength) {
        diagnostics.push(diagnostic("invalid", "release-generation-ledger-output-content", record.path, "Release ledger output bytes do not match the exact Git denominator"));
      }
    }
    const rawFixedOutputs = Array.isArray(ledger.fixedOutputs) ? ledger.fixedOutputs : [];
    const fixedOutputPaths = rawFixedOutputs.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      return typeof record.path === "string" ? record.path : null;
    });
    if (fixedOutputPaths.some((path) => path === null) || canonical(fixedOutputPaths.filter((path): path is string => path !== null).sort()) !== canonical(RELEASE_FIXED_OUTPUT_PATHS)) {
      diagnostics.push(diagnostic("invalid", "release-generation-ledger-fixed-output-set", RELEASE_LEDGER_PATH, "Release ledger must bind the separately fixed release-authority placeholder"));
    }
    for (const raw of rawFixedOutputs) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.path !== "string") continue;
      const file = byPath.get(record.path);
      if (!file || record.contentSha256 !== file.contentSha256 || record.byteLength !== file.byteLength) {
        diagnostics.push(diagnostic("invalid", "release-generation-ledger-fixed-output-content", record.path, "Fixed release output bytes do not match the exact Git denominator"));
      }
    }
    const rawGenerators = Array.isArray(ledger.generatorFiles) ? ledger.generatorFiles : [];
    for (const raw of rawGenerators) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.path !== "string") continue;
      const file = byPath.get(record.path);
      if (!file || record.contentSha256 !== file.contentSha256 || record.byteLength !== file.byteLength) {
        diagnostics.push(diagnostic("invalid", "release-generation-ledger-generator-content", record.path, "Release generator ledger entry does not match the exact Git denominator"));
      } else if (file.language !== "metadata") {
        generatorPaths.add(file.path);
      }
    }
  }
  const generatorCli = byPath.get(RELEASE_GENERATOR_CLI_PATH);
  const generatorIndex = byPath.get(RELEASE_GENERATOR_INDEX_PATH);
  if (!generatorCli || generatorCli.fileClass !== "authoring" || !generatorIndex || generatorIndex.fileClass !== "authoring") {
    diagnostics.push(diagnostic("invalid", "release-generator-cli-missing", RELEASE_GENERATOR_CLI_PATH, "Release regeneration check must be a tracked authoring source"));
    return generatorPaths;
  }
  try {
    const regenerationOutput = execFileSync(process.execPath, ["--experimental-strip-types", RELEASE_GENERATOR_CLI_PATH, "--check"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (regenerationOutput !== "release-role-manifest: exact") {
      diagnostics.push(diagnostic("invalid", "release-generation-check-output", RELEASE_LEDGER_PATH, "Fresh release regeneration did not emit the exact machine-check success marker"));
    }
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "release-generation-not-exact", RELEASE_LEDGER_PATH, `Fresh fixed regeneration does not reproduce the tracked release outputs, fixed authority, and ledger: ${String(error)}`));
  }
  return generatorPaths;
}

/**
 * The catalog generator owns the generated Family/Strategy catalogs and the
 * generated Family runtime composition.  They are not GateCore release
 * outputs, but they are still production generated authority and therefore
 * cannot fall through to the generic "paths-only" generated check.  This
 * early pass only fixes the output envelope.  The typed compiler/semantic
 * verification receipt is independently recomputed after the full compiler
 * graph and implementation closures have been observed.
 */
export function validateCatalogGeneratedTree(
  root: string,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const presentOutputs = CATALOG_OUTPUT_PATHS.filter((path) => byPath.has(path));
  const ledgerFile = byPath.get(CATALOG_LEDGER_PATH);
  if (presentOutputs.length === 0 && ledgerFile === undefined) return;
  if (canonical(presentOutputs) !== canonical(CATALOG_OUTPUT_PATHS)) {
    diagnostics.push(diagnostic(
      "invalid",
      "catalog-generated-output-set",
      CATALOG_LEDGER_PATH,
      "Catalog generation must own the exact impact receipt/snapshot, Family catalog, Strategy catalog, Family runtime composition, valuation-owner registry, and safety-profile output set",
    ));
  }
  if (ledgerFile === undefined) {
    diagnostics.push(diagnostic(
      "invalid",
      "catalog-generation-ledger-missing",
      CATALOG_LEDGER_PATH,
      "Catalog generated outputs require the fixed content-addressed regeneration ledger",
    ));
    return;
  }
  if (ledgerFile.language !== "metadata") {
    diagnostics.push(diagnostic(
      "invalid",
      "catalog-generation-ledger-class",
      CATALOG_LEDGER_PATH,
      "Catalog generation ledger must be a tracked metadata file",
    ));
  }
  const generatorCli = byPath.get(CATALOG_GENERATOR_CLI_PATH);
  if (generatorCli === undefined || generatorCli.fileClass !== "authoring") {
    diagnostics.push(diagnostic(
      "invalid",
      "catalog-generator-cli-missing",
      CATALOG_GENERATOR_CLI_PATH,
      "Catalog regeneration check must be a tracked authoring source",
    ));
    return;
  }
}

/**
 * Exact-decode the independently emitted catalog verification receipt and
 * compare it to boundary-owned facts.  Text markers, caller verdicts, and
 * partially matching receipts are all invalid transports.
 */
export function validateCatalogGenerationVerificationReceipt(
  actual: unknown,
  expected: CatalogGenerationVerificationReceiptV1,
  diagnostics: BoundaryDiagnostic[],
): CatalogGenerationVerificationReceiptV1 | null {
  try {
    return assertCatalogGenerationVerificationReceiptExact(actual, expected);
  } catch (error) {
    diagnostics.push(diagnostic(
      "invalid",
      "catalog-generation-verification-receipt",
      CATALOG_LEDGER_PATH,
      `Catalog verification receipt does not exact-join boundary-owned facts: ${String(error)}`,
    ));
    return null;
  }
}

function exactCatalogClosureCandidate(
  implementationClosures: readonly ImplementationClosure[],
  spec: ReturnType<typeof currentCatalogCompilerEntrypointSpecs>[number],
  role: string,
): ImplementationClosure {
  const candidates = selectCatalogCompilerClosureCandidates(implementationClosures, spec);
  if (candidates.length !== 1) {
    throw new TypeError(`catalog ${role} closure binding is not unique ${spec.modulePath}#${spec.exportName} (${candidates.length})`);
  }
  const selected = implementationClosures.find(value => value.entrypointId === candidates[0]!.entrypointId);
  if (selected === undefined) throw new TypeError(`catalog ${role} closure disappeared ${candidates[0]!.entrypointId}`);
  return selected;
}

function catalogCompilerFactFromBoundary(
  implementationClosures: readonly ImplementationClosure[],
  spec: { readonly modulePath: string; readonly exportName: string },
  role: string,
): CatalogCompilerClosureFactV1 {
  const closure = exactCatalogClosureCandidate(implementationClosures, {
    ...spec,
    preferredKind: "compiler-root",
  }, role);
  return projectCatalogCompilerClosureFacts(
    { implementationClosures },
    [{ modulePath: spec.modulePath, exportName: spec.exportName, entrypointId: closure.entrypointId }],
  )[0]!;
}

function recomputeCatalogGenerationVerificationReceipt(
  root: string,
  scannedFileSetRoot: string,
  compilerGraphRoot: string,
  implementationClosures: readonly ImplementationClosure[],
): CatalogGenerationVerificationReceiptV1 {
  const compilerSpecs = currentCatalogCompilerEntrypointSpecs();
  const capabilitySpecs = currentCatalogCapabilityProposalSpecs();
  const compilerBindings: CatalogCompilerClosureBindingV1[] = compilerSpecs.map(spec => ({
    modulePath: spec.modulePath,
    exportName: spec.exportName,
    entrypointId: exactCatalogClosureCandidate(implementationClosures, spec, "compiler").entrypointId,
  }));
  const capabilityBindings: CatalogCapabilityProposalBindingV1[] = capabilitySpecs.map(spec => ({
    capabilityId: spec.capabilityId,
    version: spec.version,
    schemaHash: spec.schemaHash,
    interpreterHash: spec.interpreterHash,
    modulePath: spec.modulePath,
    exportName: spec.exportName,
    entrypointId: exactCatalogClosureCandidate(implementationClosures, spec, "capability").entrypointId,
  }));
  const observedCompilerFacts = projectCatalogCompilerClosureFacts({ implementationClosures }, compilerBindings);
  const observedProposedCapabilitySet = projectCatalogProposedCapabilitySet({ implementationClosures }, capabilityBindings);
  const persisted = readCurrentCatalogInput(root);
  const semanticInput = currentCatalogInput(root);
  const artifacts = generateCatalogWithImpact(semanticInput, persisted.priorCatalogImpact);
  const semanticErrors = verifyCatalogLedger(root, artifacts);
  if (semanticErrors.length > 0) {
    throw new TypeError(`catalog semantic regeneration is not exact: ${semanticErrors.join(",")}`);
  }
  const observedGeneratorLeaf = observedCompilerFacts.find(value =>
    value.modulePath === CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT.modulePath
    && value.exportName === CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT.exportName
  );
  if (observedGeneratorLeaf === undefined) throw new TypeError("catalog semantic generator leaf is missing from the compiler observation");
  if (artifacts.ledger.generatorRecords.length !== 1) throw new TypeError("catalog semantic ledger must contain one generator record");
  const observerImplementation = catalogCompilerFactFromBoundary(
    implementationClosures,
    CATALOG_COMPILER_OBSERVER_ENTRYPOINT,
    "observer implementation",
  );
  const verifierImplementation = catalogCompilerFactFromBoundary(
    implementationClosures,
    CATALOG_GENERATION_VERIFIER_ENTRYPOINT,
    "verifier implementation",
  );
  return createCatalogGenerationVerificationReceiptV1({
    candidateDenominatorRoot: catalogCandidateDenominatorRoot({
      scannedFileSetRoot: scannedFileSetRoot as Hash,
      compilerGraphRoot: compilerGraphRoot as Hash,
    }),
    indexDenominatorRoot: catalogIndexDenominatorRoot({
      compilerEntrypoints: compilerSpecs,
      capabilityProposals: capabilitySpecs,
    }),
    scannedFileSetRoot: scannedFileSetRoot as Hash,
    compilerGraphRoot: compilerGraphRoot as Hash,
    observedCompilerFactsRoot: catalogCompilerFactsRoot(observedCompilerFacts),
    persistedCompilerFactsRoot: catalogCompilerFactsRoot(persisted.compilerClosures),
    observedProposedCapabilitySetRoot: observedProposedCapabilitySet.root,
    persistedProposedCapabilitySetRoot: persisted.proposedCapabilitySet.root,
    observerImplementation,
    verifierImplementation,
    observedGeneratorLeaf,
    ledgerGeneratorRecord: artifacts.ledger.generatorRecords[0]!,
    semanticLedgerHash: artifacts.ledger.ledgerHash,
    semanticOutputRoot: artifacts.outputRoot,
    impactSnapshotRoot: artifacts.impactSnapshot.snapshotRoot,
    impactReceiptRoot: artifacts.impactReceipt.receiptRoot,
  });
}

function validateCatalogGenerationVerification(
  root: string,
  files: readonly TrackedFile[],
  scannedFileSetRoot: string,
  compilerGraphRoot: string,
  implementationClosures: readonly ImplementationClosure[],
  diagnostics: BoundaryDiagnostic[],
): CatalogGenerationVerificationReceiptV1 | null {
  const paths = new Set(files.map(value => value.path));
  if (!paths.has(CATALOG_LEDGER_PATH) && !CATALOG_OUTPUT_PATHS.some(path => paths.has(path))) return null;
  let expected: CatalogGenerationVerificationReceiptV1;
  try {
    expected = recomputeCatalogGenerationVerificationReceipt(
      root,
      scannedFileSetRoot,
      compilerGraphRoot,
      implementationClosures,
    );
  } catch (error) {
    diagnostics.push(diagnostic(
      "invalid",
      "catalog-generation-boundary-recompute",
      CATALOG_LEDGER_PATH,
      `Boundary could not recompute the catalog compiler and semantic facts: ${String(error)}`,
    ));
    return null;
  }
  let actual: CatalogGenerationVerificationReceiptV1;
  try {
    actual = verifyCurrentCatalogGeneration(root);
  } catch (error) {
    diagnostics.push(diagnostic(
      "invalid",
      "catalog-generation-verifier-invalid",
      CATALOG_LEDGER_PATH,
      `Independent catalog verifier did not emit a typed exact receipt: ${String(error)}`,
    ));
    return null;
  }
  return validateCatalogGenerationVerificationReceipt(actual, expected, diagnostics);
}

function validateGeneratedTree(root: string, files: readonly TrackedFile[], requireReleaseTree: boolean, diagnostics: BoundaryDiagnostic[]): Set<string> {
  const generated = files.filter((file) => file.fileClass === "generated");
  const generatorPaths = validateReleaseGeneratedTree(root, files, generated, requireReleaseTree, diagnostics);
  validateCatalogGeneratedTree(root, files, diagnostics);
  const generatedByKnownOwner = new Set([
    ...RELEASE_OUTPUT_PATHS,
    ...CATALOG_OUTPUT_PATHS,
    SCHEDULER_AUTHORITY_PATH,
    FAMILY_EXECUTION_COMPOSITION_PATH,
  ]);
  // The scheduler authority is a separately fixed fail-closed placeholder,
  // not a release-role generator output.  It is validated by the exact-null
  // check in runBoundaryGate and must not be mistaken for an unqualified
  // hand-authored generated tree.
  const genericGenerated = generated.filter((file) => !generatedByKnownOwner.has(file.path));
  if (genericGenerated.length === 0) return generatorPaths;
  diagnostics.push(diagnostic(
    "invalid",
    "generated-regeneration-contract-missing",
    genericGenerated.map((file) => file.path).sort().join(","),
    "Every non-release generated output requires its own fixed content-addressed ledger and fresh exact regeneration adapter; a self-authored paths-only manifest has no authority",
  ));
  return generatorPaths;
}

function validateReleaseGeneratorCompilerClosure(
  root: string,
  files: readonly TrackedFile[],
  implementationClosures: readonly ImplementationClosure[],
  diagnostics: BoundaryDiagnostic[],
): void {
  if (!files.some((file) => file.path === RELEASE_LEDGER_PATH)) return;
  const ledger = readJson(root, RELEASE_LEDGER_PATH, diagnostics);
  if (ledger === null) return;
  const rawGeneratorFiles = Array.isArray(ledger.generatorFiles) ? ledger.generatorFiles : [];
  const declaredSources = rawGeneratorFiles.flatMap((value): string[] => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const path = (value as Record<string, unknown>).path;
    if (typeof path !== "string") return [];
    const file = files.find((candidate) => candidate.path === path);
    return file && (file.language === "typescript" || file.language === "javascript") ? [path] : [];
  }).sort();
  const generatorRoots = [
    "tools/release-role-manifest/src/cli.ts",
    "tools/release-role-manifest/src/index.ts",
  ];
  const closures = generatorRoots.map((entrypoint) => implementationClosures.find((closure) =>
    closure.kind === "compiler-root" &&
    closure.configPath === "tools/release-role-manifest/tsconfig.json" &&
    closure.entrypoint === entrypoint));
  if (closures.some((closure) => closure === undefined)) {
    diagnostics.push(diagnostic("invalid", "release-generator-compiler-closure-missing", RELEASE_LEDGER_PATH, "Release generator roots must each have an isolated compiler-derived closure"));
    return;
  }
  const expectedSources = Array.from(new Set(closures.flatMap((closure) => closure!.files.map((file) => file.path)))).sort();
  if (canonical(declaredSources) !== canonical(expectedSources)) {
    diagnostics.push(diagnostic("invalid", "release-generator-compiler-closure-mismatch", RELEASE_LEDGER_PATH, "Release ledger generator sources must exactly equal the union of the isolated compiler-derived generator closures"));
  }
  for (const closure of closures as readonly ImplementationClosure[]) {
    const inputKinds = new Set(closure.programInputs.map((input) => input.kind));
    if (!inputKinds.has("typescript-compiler") || !inputKinds.has("typescript-lib") || computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot) {
      diagnostics.push(diagnostic("invalid", "release-generator-compiler-inputs-incomplete", closure.entrypointId, "Release generator closure must bind the exact compiler, default libraries, ambient inputs, and recomputed input root"));
    }
  }
}

export function validateDependencyBoundaries(
  files: readonly TrackedFile[],
  edges: readonly GraphEdge[],
  diagnostics: BoundaryDiagnostic[],
  sourceRoot = process.cwd(),
): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  // Dependency graph treatment intentionally follows the historical compiler
  // denominator convention.  A source named `test-support.ts` is still a
  // production-classified central source until the closure-specific check
  // below proves it is a fixture; changing this here would hide constructor
  // edges rather than report them.
  const testOrFixture = (path: string): boolean =>
    /(?:^|\/)(?:test|tests|fixture|fixtures)\//.test(path) || /(?:^|\.)test\.[^.]+$/.test(path) || /(?:^|\.)spec\.[^.]+$/.test(path);
  const isSpecs = (path: string): boolean => path.startsWith("specs/");
  const isCanonicalCodec = (path: string): boolean => path.startsWith("packages/canonical-codec/");
  const isGeneratedComposition = (path: string): boolean => /(?:^|\/)(?:runtime|production)-composition\.[^.]+$/.test(path) || path.includes("/runtime-composition/");
  const isFamilyPublic = (path: string): boolean => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base === "index.ts"
      || base === "index.js"
      || base === "public.ts"
      || base === "public.js"
      || base.endsWith("-public.ts")
      || path.includes("/public/");
  };
  const isPublicPluginEntry = (file: TrackedFile): boolean => (file.fileClass === "family" || file.fileClass === "strategy") && isFamilyPublic(file.path);
  const isValuationOwnerRuntimeEntry = (file: TrackedFile): boolean =>
    file.fileClass === "valuation-owner" && /\/src\/(?:runtime|public)\.(?:ts|js)$/.test(file.path);
  const isFamilyAllowedCentralImport = (path: string): boolean => FAMILY_CENTRAL_IMPORT_ALLOWLIST.some((prefix) => path.startsWith(prefix));
  const isStrategyAllowedCentralImport = (path: string): boolean => STRATEGY_CENTRAL_IMPORT_ALLOWLIST.some((allowed) => path === allowed);
  const isValuationOwnerAllowedCentralImport = (path: string): boolean =>
    VALUATION_OWNER_CENTRAL_IMPORT_ALLOWLIST.some((allowed) => path.startsWith(allowed));
  const isCentralInternalPath = (path: string): boolean => path.includes("/src/internal/");
  const isAuthorityConstructorPath = (path: string): boolean =>
    isCentralInternalPath(path) || KNOWN_AUTHORITY_CONSTRUCTOR_PATHS.has(path) || SENSITIVE_PUBLIC_CONSTRUCTOR_PATHS.has(path);
  const edgeImportsAnyRuntimeName = (edge: GraphEdge, names: ReadonlySet<string>): boolean => {
    const source = byPath.get(edge.from);
    if (source === undefined) return true;
    let sourceText: string;
    try {
      sourceText = readFileSync(resolve(sourceRoot, source.path), "utf8");
    } catch {
      return true;
    }
    const sourceFile = ts.createSourceFile(source.path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === edge.specifier) {
        const clause = statement.importClause;
        if (clause === undefined) return true;
        if (clause.isTypeOnly) continue;
        if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return true;
        if (clause.namedBindings.elements.some(element =>
          !element.isTypeOnly && names.has(element.propertyName?.text ?? element.name.text))) return true;
      }
      if (ts.isExportDeclaration(statement)
        && statement.moduleSpecifier !== undefined
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === edge.specifier) {
        if (statement.isTypeOnly) continue;
        if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) return true;
        if (statement.exportClause.elements.some(element =>
          !element.isTypeOnly && names.has(element.propertyName?.text ?? element.name.text))) return true;
      }
    }
    return false;
  };
  const validateAuthorityNamedImport = (edge: GraphEdge, expected: readonly string[]): void => {
    const source = byPath.get(edge.from);
    if (!source) return;
    let sourceText: string;
    try {
      sourceText = readFileSync(resolve(sourceRoot, source.path), "utf8");
    } catch {
      return;
    }
    const sourceFile = ts.createSourceFile(source.path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const matching = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === edge.specifier);
    const runtimeMatching = matching.filter(statement => {
      const clause = statement.importClause;
      if (clause === undefined) return true;
      if (clause.isTypeOnly) return false;
      if (clause.name !== undefined || clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) {
        return true;
      }
      return clause.namedBindings.elements.length === 0
        || clause.namedBindings.elements.some(element => !element.isTypeOnly);
    });
    const matchingExports = sourceFile.statements.filter((statement): statement is ts.ExportDeclaration =>
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === edge.specifier);
    const runtimeMatchingExports = matchingExports.filter(statement => {
      if (statement.isTypeOnly) return false;
      if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) return true;
      return statement.exportClause.elements.length === 0
        || statement.exportClause.elements.some(element => !element.isTypeOnly);
    });
    let alternateRuntimeLoad = false;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === edge.specifier) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) alternateRuntimeLoad = true;
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression) && node.moduleReference.expression.text === edge.specifier) alternateRuntimeLoad = true;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const imported = matching.flatMap(statement => {
      const clause = statement.importClause;
      if (!clause) return ["<non-exact>"];
      // Type-only imports cannot carry a runtime constructor/capability and
      // therefore do not participate in the exact runtime named-import set.
      // They remain visible to the dependency-boundary edge itself.
      if (clause.isTypeOnly) return [];
      if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return ["<non-exact>"];
      return clause.namedBindings.elements.flatMap(element => {
        if (element.isTypeOnly) return [];
        return [element.name.text !== (element.propertyName?.text ?? element.name.text)
          ? "<non-exact>"
          : element.name.text];
      });
    }).sort();
    const runtimeImportShapeInvalid = expected.length === 0
      ? matching.length === 0 || runtimeMatching.length !== 0
      : runtimeMatching.length === 0;
    if (runtimeImportShapeInvalid || runtimeMatchingExports.length !== 0 || alternateRuntimeLoad
      || canonical(imported) !== canonical([...expected].sort())) {
      diagnostics.push(diagnostic("fail", "authority-named-import-mismatch", edge.from, `Authority edge must import exactly ${expected.join(", ")} from ${edge.to}`));
    }
  };
  const validatePreReleaseSchemaAuthorityImport = (
    edge: GraphEdge,
    expected: (typeof PRE_RELEASE_SCHEMA_AUTHORITY_IMPORTS)[number],
  ): void => {
    const source = byPath.get(edge.from);
    if (source === undefined) return;
    let sourceText: string;
    try {
      sourceText = readFileSync(resolve(sourceRoot, source.path), "utf8");
    } catch {
      return;
    }
    const sourceFile = ts.createSourceFile(source.path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imported: string[] = [];
    const exported: string[] = [];
    let invalid = false;
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === edge.specifier) {
        const clause = statement.importClause;
        if (clause === undefined || clause.isTypeOnly) continue;
        if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) {
          invalid = true;
          continue;
        }
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const sourceName = element.propertyName?.text ?? element.name.text;
          if (!PRE_RELEASE_SCHEMA_RESTRICTED_RUNTIME_EXPORTS.has(sourceName)) continue;
          if (element.name.text !== sourceName) invalid = true;
          imported.push(sourceName);
        }
      }
      if (ts.isExportDeclaration(statement)
        && statement.moduleSpecifier !== undefined
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === edge.specifier
        && !statement.isTypeOnly) {
        if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) {
          invalid = true;
          continue;
        }
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const sourceName = element.propertyName?.text ?? element.name.text;
          if (!PRE_RELEASE_SCHEMA_RESTRICTED_RUNTIME_EXPORTS.has(sourceName)) continue;
          if (element.name.text !== sourceName) invalid = true;
          exported.push(sourceName);
        }
      }
    }
    if (invalid
      || canonical(imported.sort()) !== canonical([...expected.imported].sort())
      || canonical(exported.sort()) !== canonical([...expected.exported].sort())) {
      diagnostics.push(diagnostic(
        "fail",
        "pre-release-schema-consumer",
        edge.from,
        "Pre-release schema authority must use the exact fixed runtime import and re-export surface",
      ));
    }
  };
  const validateNarrowPortImport = (
    edge: GraphEdge,
    expected: readonly { readonly name: string; readonly typeOnly: boolean }[],
  ): void => {
    const source = byPath.get(edge.from);
    if (!source) return;
    let sourceText: string;
    try {
      sourceText = readFileSync(resolve(sourceRoot, source.path), "utf8");
    } catch {
      return;
    }
    const sourceFile = ts.createSourceFile(source.path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const matching = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === edge.specifier);
    const imported = matching.flatMap((statement) => {
      const clause = statement.importClause;
      if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        return [{ name: "<non-exact>", typeOnly: false }];
      }
      return clause.namedBindings.elements.map((element) => ({
        name: element.name.text === (element.propertyName?.text ?? element.name.text) ? element.name.text : "<non-exact>",
        typeOnly: clause.isTypeOnly || element.isTypeOnly,
      }));
    }).sort((left, right) => `${left.typeOnly}:${left.name}`.localeCompare(`${right.typeOnly}:${right.name}`));
    const normalizedExpected = [...expected].sort((left, right) => `${left.typeOnly}:${left.name}`.localeCompare(`${right.typeOnly}:${right.name}`));
    if (canonical(imported) !== canonical(normalizedExpected)) {
      diagnostics.push(diagnostic(
        "fail",
        "narrow-port-import-mismatch",
        edge.from,
        `Narrow authority edge must import exactly the owner-issued projection from ${edge.to}`,
      ));
    }
  };
  for (const edge of edges) {
    const from = byPath.get(edge.from);
    const to = byPath.get(edge.to);
    if (!from) continue;
    const fromIsTest = testOrFixture(from.path);
    // Tests and fixtures are observed separately; they must never create a
    // production import edge or make the production closure appear larger.
    if (fromIsTest) continue;
    const external = edge.to.startsWith("@external/");
    if (external) {
      const forbiddenGovernanceExternal =
        (from.fileClass === "acceptance-pure-core" && !PURE_GOVERNANCE_NODE_BUILTINS.has(edge.specifier)) ||
        from.fileClass === "generated" ||
        (from.fileClass === "central" && isSpecs(from.path)) ||
        (from.fileClass === "reference-only" && !edge.specifier.startsWith("node:"));
      if (forbiddenGovernanceExternal) diagnostics.push(diagnostic("fail", "governance-imports-external", edge.from, `Governance source cannot import external dependency ${edge.specifier}`));
      continue;
    }
    if (!to) continue;
    const generatedReleaseAuthorityImport = from.path === RELEASE_RUNTIME_PATH && to.path === RELEASE_AUTHORITY_PATH;
    const productionReleaseRuntimeImport = from.fileClass === "production-runtime" && to.path === RELEASE_RUNTIME_PATH;
    const qualifiedReleaseRunnerImport = from.path === QUALIFIED_RELEASE_RUNNER_OWNER_PATH && to.path === RELEASE_RUNTIME_PATH;
    const familyRuntimeCompositionImport = (from.path === RUNTIME_RELEASE_BOOTSTRAP_PATH
      || from.path === RUNTIME_RELEASE_HTTP_FAMILY_PHYSICAL_OWNER_PATH)
      && to.path === FAMILY_RUNTIME_COMPOSITION_PATH;
    const valuationOwnerRuntimeCompositionImport = from.path === RUNTIME_RELEASE_ECONOMIC_SAFETY_OWNER_PATH
      && to.path === VALUATION_OWNER_RUNTIME_COMPOSITION_PATH;
    const authorityOwnerEdge = AUTHORITY_OWNER_EDGES.has(`${edge.from}\u2192${edge.to}`);
    if (to.path === PRE_RELEASE_TERMINAL_PHYSICAL_STATE_PATH && !authorityOwnerEdge) {
      diagnostics.push(diagnostic(
        "fail",
        "pre-release-terminal-physical-state-owner",
        edge.from,
        "Terminal physical observation state has only the fixed snapshot-owner registrar and public-reader consumers",
      ));
    }
    const restrictedPreReleaseExports = PRE_RELEASE_RESTRICTED_RUNTIME_EXPORTS.get(to.path);
    if (restrictedPreReleaseExports !== undefined
      && edgeImportsAnyRuntimeName(edge, restrictedPreReleaseExports)
      && !authorityOwnerEdge) {
      diagnostics.push(diagnostic(
        "fail",
        "pre-release-authority-reader-owner",
        edge.from,
        `Pre-release receipt, Stage 2, and release-binding authority may be reached only through its exact fixed consumer edge: ${edge.to}`,
      ));
    }
    if (GATE_CORE_AUTHORITY_CONSTRUCTOR_PATHS.has(to.path) && !authorityOwnerEdge) {
      diagnostics.push(diagnostic(
        "fail",
        "gate-core-authority-owner",
        edge.from,
        `GateCore authority state may be reached only through its exact owner or consumer edge: ${edge.to}`,
      ));
    }
    if (
      (to.path === COLLECTOR_PREDICATE_MATERIAL_SOURCE_OWNER_PATH
        || to.path === COLLECTOR_PREDICATE_MATERIAL_SOURCE_ISSUER_PATH
        || to.path === COLLECTOR_PREDICATE_MATERIAL_BRIDGE_ISSUER_PATH)
      && !authorityOwnerEdge
    ) {
      diagnostics.push(diagnostic(
        "fail",
        "predicate-material-source-authority-owner",
        edge.from,
        `Predicate material source authority may be reached only through its exact owner or consumer edge: ${edge.to}`,
      ));
    }
    if (
      (to.path === RUNTIME_RELEASE_OBSERVER_STORE_OWNER_PATH
        || to.path === ROOT_PREDICATE_MATERIAL_SOURCE_OWNER_PATH)
      && !authorityOwnerEdge
    ) {
      diagnostics.push(diagnostic(
        "fail",
        "production-release-advisory-authority-owner",
        edge.from,
        `Production release advisory observation authority may be reached only through its exact owner or consumer edge: ${edge.to}`,
      ));
    }
    if (
      (to.path === CURRENT_CATALOG_IMPACT_STATE_PATH
        || to.path === NOMINATION_QUALIFICATION_REUSE_STATE_PATH)
      && !authorityOwnerEdge
    ) {
      diagnostics.push(diagnostic(
        "fail",
        "catalog-nomination-reuse-authority-owner",
        edge.from,
        `Catalog impact and nomination reuse capabilities may cross only their exact owner or consumer edge: ${edge.to}`,
      ));
    }
    const authorityNamedImports = AUTHORITY_NAMED_IMPORTS.get(`${edge.from}\u2192${edge.to}`);
    if (authorityNamedImports) validateAuthorityNamedImport(edge, authorityNamedImports);
    const preReleaseSchemaImport = PRE_RELEASE_SCHEMA_AUTHORITY_IMPORTS.find(candidate =>
      candidate.from === edge.from && candidate.to === edge.to);
    if (preReleaseSchemaImport !== undefined) {
      validatePreReleaseSchemaAuthorityImport(edge, preReleaseSchemaImport);
    }
    const authorityModuleSpecifier = AUTHORITY_MODULE_SPECIFIERS.get(`${edge.from}\u2192${edge.to}`);
    if (authorityModuleSpecifier !== undefined && edge.specifier !== authorityModuleSpecifier) {
      diagnostics.push(diagnostic(
        "fail",
        "authority-module-specifier-mismatch",
        edge.from,
        `Authority edge must use exact module specifier ${authorityModuleSpecifier}`,
      ));
    }
    const narrowPortImports = REVM_NARROW_PORT_IMPORTS.get(`${edge.from}\u2192${edge.to}`);
    if (narrowPortImports) validateNarrowPortImport(edge, narrowPortImports);
    const activeReadyGraphObserverEdge = edge.from === PRE_RELEASE_FACT_LOG_PATH
      && edge.to === PRE_RELEASE_ACTIVE_READY_GRAPH_OBSERVER_PATH;
    if (activeReadyGraphObserverEdge) {
      if (edge.specifier !== PRE_RELEASE_ACTIVE_READY_GRAPH_OBSERVER_SPECIFIER) {
        diagnostics.push(diagnostic(
          "fail",
          "pre-release-ready-graph-observer-specifier",
          edge.from,
          "Pre-release fact log must consume the fixed public Ready Graph observer module",
        ));
      }
      validateNarrowPortImport(edge, Object.freeze([
        Object.freeze({ name: "assertActiveReadyGraphCoarseSweepDenominatorV1", typeOnly: false }),
        Object.freeze({ name: "observeFrozenPreReleaseBActiveReadyGraphV1", typeOnly: false }),
        Object.freeze({ name: "ProductionActiveReadyGraphSnapshotV1", typeOnly: true }),
      ]));
    }
    if (edge.to === PRE_RELEASE_ACTIVE_READY_GRAPH_OBSERVER_PATH && !activeReadyGraphObserverEdge) {
      diagnostics.push(diagnostic(
        "fail",
        "pre-release-ready-graph-observer-consumer",
        edge.from,
        "The frozen-B Ready Graph observer has one exact cross-tool consumer",
      ));
    }
    if (edge.to === PRE_RELEASE_ACTIVE_READY_GRAPH_OWNER_PATH
      && edge.from.startsWith("tools/")
      && !edge.from.startsWith("tools/runtime-release-packager/")) {
      diagnostics.push(diagnostic(
        "fail",
        "pre-release-ready-graph-owner-cross-tool",
        edge.from,
        "Cross-tool readers must consume the public Ready Graph observer, never its internal owner",
      ));
    }
    const terminalPhysicalObserverEdge = edge.from === PRE_RELEASE_FACT_LOG_PATH
      && edge.to === PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_PATH;
    if (terminalPhysicalObserverEdge) {
      if (edge.specifier !== PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_SPECIFIER) {
        diagnostics.push(diagnostic(
          "fail",
          "pre-release-terminal-physical-observer-specifier",
          edge.from,
          "Pre-release FactLog must consume the fixed public terminal physical observer module",
        ));
      }
      validateNarrowPortImport(edge, Object.freeze([
        Object.freeze({ name: "readPreReleaseBTerminalPhysicalObservationV1", typeOnly: false }),
        Object.freeze({ name: "PreReleaseBTerminalPhysicalObservationCapabilityV1", typeOnly: true }),
        Object.freeze({ name: "PreReleaseBTerminalPhysicalObservationV1", typeOnly: true }),
      ]));
    }
    if (edge.to === PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_PATH
      && edge.from.startsWith("tools/")
      && !edge.from.startsWith("tools/runtime-release-packager/")
      && !terminalPhysicalObserverEdge) {
      diagnostics.push(diagnostic(
        "fail",
        "pre-release-terminal-physical-observer-consumer",
        edge.from,
        "The terminal physical observer has one exact cross-tool FactLog consumer",
      ));
    }
    const finalRunnerFactLogEdge = edge.from === FINAL_PRE_RELEASE_RUNNER_PATH
      && edge.to === PRE_RELEASE_FACT_LOG_PATH;
    if (finalRunnerFactLogEdge) {
      if (edge.specifier !== FINAL_PRE_RELEASE_FACT_LOG_SPECIFIER) {
        diagnostics.push(diagnostic(
          "fail",
          "final-pre-release-fact-log-specifier",
          edge.from,
          "Final pre-release must consume the fixed FactLog production reader",
        ));
      }
      validateNarrowPortImport(edge, Object.freeze([
        Object.freeze({ name: "encodePreReleaseFactLogJsonlV1", typeOnly: false }),
        Object.freeze({ name: "readPreReleaseFactLogV1", typeOnly: false }),
      ]));
    }
    if (
      from.path.startsWith("runtime/revm-workers/src/")
      && to.path === RELEASE_AUTHORITY_SPEC_PATH
      && narrowPortImports === undefined
    ) {
      diagnostics.push(diagnostic(
        "fail",
        "revm-imports-full-release-binding",
        edge.from,
        "REVM worker code may consume only the schema-owned RuntimeReleaseExecutorLeaseV1 projection; full release binding/certificate authority must remain outside the worker boundary",
      ));
    }
    if (from.path === "packages/ready-generation/src/index.ts" && to.path === RELEASE_AUTHORITY_SPEC_PATH) {
      diagnostics.push(diagnostic(
        "fail",
        "ready-generation-imports-shape-only-release-port",
        edge.from,
        "ReadyGeneration must consume the runtime-release-authority-issued ready binding consumer, not a structural release port imported from the wire specs",
      ));
    }
    const importsAuthorityConstructor = (() => {
      if (!isAuthorityConstructorPath(to.path)) return false;
      if (isCentralInternalPath(to.path) || KNOWN_AUTHORITY_CONSTRUCTOR_PATHS.has(to.path)) return true;
      const sensitiveNames = SENSITIVE_PUBLIC_RUNTIME_IMPORTS.get(to.path);
      if (sensitiveNames === undefined) return true;
      const source = byPath.get(edge.from);
      if (source === undefined) return true;
      let sourceText: string;
      try {
        sourceText = readFileSync(resolve(sourceRoot, source.path), "utf8");
      } catch {
        return true;
      }
      const sourceFile = ts.createSourceFile(source.path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)
          || statement.isTypeOnly
          || statement.moduleSpecifier === undefined
          || !ts.isStringLiteral(statement.moduleSpecifier)
          || statement.moduleSpecifier.text !== edge.specifier) continue;
        if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) return true;
        if (statement.exportClause.elements.some(element =>
          !element.isTypeOnly
          && sensitiveNames.has(element.propertyName?.text ?? element.name.text))) return true;
      }
      const matching = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement)
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === edge.specifier);
      if (matching.length !== 1) return true;
      const clause = matching[0]!.importClause;
      if (clause === undefined || clause.isTypeOnly) return false;
      if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return true;
      return clause.namedBindings.elements.some((element) =>
        !element.isTypeOnly && sensitiveNames.has(element.propertyName?.text ?? element.name.text));
    })();
    if (to.path === RELEASE_ASSEMBLED_ACCEPTANCE_PATH
      && importsAuthorityConstructor
      && !authorityOwnerEdge) {
      diagnostics.push(diagnostic(
        "fail",
        "qualified-release-runner-authority-owner",
        edge.from,
        `Qualified release runner install, run, and verified-lineage ports may be consumed only by the fixed workflow and production observer owners: ${edge.to}`,
      ));
    }
    if (testOrFixture(to.path)) diagnostics.push(diagnostic("fail", "production-imports-test-fixture", edge.from, `Non-test source imports test/fixture source ${edge.to}`));
    if (from.fileClass === "central") {
      if (to.fileClass === "family") diagnostics.push(diagnostic("fail", "central-imports-family", edge.from, `Central code imports Family source ${edge.to}`));
      if (to.fileClass === "strategy") diagnostics.push(diagnostic("fail", "central-imports-strategy", edge.from, `Central code imports Strategy source ${edge.to}`));
      if (to.fileClass === "valuation-owner") diagnostics.push(diagnostic("fail", "central-imports-valuation-owner", edge.from, `Central code imports concrete valuation-owner source ${edge.to}`));
      if (to.fileClass === "production-runtime" && !CENTRAL_RUNTIME_OWNER_EDGES.has(`${edge.from}\u2192${edge.to}`)) {
        diagnostics.push(diagnostic("fail", "central-imports-runtime", edge.from, `Central code imports runtime source ${edge.to}`));
      }
      if ((to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector" || to.fileClass === "reference-only")
        && !authorityOwnerEdge) diagnostics.push(diagnostic("fail", "central-imports-governance-tool", edge.from, `Central code imports governance/acceptance source ${edge.to}`));
      if (to.fileClass === "generated" && !familyRuntimeCompositionImport && !valuationOwnerRuntimeCompositionImport) diagnostics.push(diagnostic("fail", "central-imports-generated", edge.from, `Central code cannot import generated concrete/composition output ${edge.to}`));
      if (isSpecs(from.path) && !isSpecs(to.path) && !isCanonicalCodec(to.path)) diagnostics.push(diagnostic("fail", "specs-import-outside-frozen-closure", edge.from, `Frozen specs may only import specs or canonical-codec: ${edge.to}`));
    }
    if (from.fileClass === "production-runtime") {
      if ((to.fileClass === "authoring" || to.fileClass === "reference-only") && !authorityOwnerEdge) diagnostics.push(diagnostic("fail", "runtime-imports-authoring", edge.from, `Runtime imports ${to.fileClass} source ${edge.to}`));
      if (to.fileClass === "family" || to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector") diagnostics.push(diagnostic("fail", "runtime-imports-family-or-acceptance", edge.from, `Runtime cannot import Family or acceptance implementation ${edge.to}`));
      if (to.fileClass === "strategy") diagnostics.push(diagnostic("fail", "runtime-imports-strategy", edge.from, `Runtime must consume generated composition, not concrete Strategy source ${edge.to}`));
      if (to.fileClass === "valuation-owner") diagnostics.push(diagnostic("fail", "runtime-imports-valuation-owner", edge.from, `Runtime must consume generated valuation-owner composition, not concrete owner source ${edge.to}`));
      if (importsAuthorityConstructor && !authorityOwnerEdge) diagnostics.push(diagnostic("fail", "runtime-imports-authority-constructor", edge.from, `Production runtime cannot import an authority constructor directly: ${edge.to}`));
    }
    if (from.fileClass === "acceptance-pure-core" && to.fileClass !== "acceptance-pure-core" && !isSpecs(to.path) && !isCanonicalCodec(to.path) && !generatedReleaseAuthorityImport) diagnostics.push(diagnostic("fail", "acceptance-imports-production", edge.from, `Acceptance pure core may only import itself, frozen specs, canonical-codec, or the exact generated release authority: ${edge.to}`));
    if (from.fileClass === "acceptance-collector" && (to.fileClass === "production-runtime" || to.fileClass === "family" || to.fileClass === "reference-only")) diagnostics.push(diagnostic("fail", "collector-imports-production", edge.from, `Collector cannot import production or reference-only implementation ${edge.to}`));
    if (from.fileClass === "acceptance-collector" && importsAuthorityConstructor && !authorityOwnerEdge) diagnostics.push(diagnostic("fail", "collector-imports-authority-constructor", edge.from, `Collector cannot import an authority constructor outside its exact owner edge: ${edge.to}`));
    if (from.fileClass === "reference-only" && !isSpecs(to.path) && !isCanonicalCodec(to.path) && to.fileClass !== "reference-only") diagnostics.push(diagnostic("fail", "reference-imports-production", edge.from, `Reference-only code may only import frozen specs, canonical-codec, or local reference code: ${edge.to}`));
    if (from.fileClass === "family" && to.fileClass === "production-runtime") diagnostics.push(diagnostic("fail", "family-imports-runtime", edge.from, `Family code cannot import production runtime source ${edge.to}`));
    if (from.fileClass === "family" && to.fileClass === "central" && (isCentralInternalPath(to.path) || !isFamilyAllowedCentralImport(to.path))) diagnostics.push(diagnostic("fail", "family-imports-forbidden-central", edge.from, `Family dependencies are default-deny; only frozen runtime refs, capability contracts, canonical-codec, or the pure artifact-fingerprint contract subtree are allowed: ${edge.to}`));
    if (from.fileClass === "strategy" && to.fileClass === "central" && !isStrategyAllowedCentralImport(to.path)) diagnostics.push(diagnostic("fail", "strategy-imports-forbidden-central", edge.from, `Strategy dependencies are default-deny; only neutral capability/runtime-ref contracts, canonical-codec, pure artifact-fingerprint, strategy-sdk, and release-intent specs are allowed: ${edge.to}`));
    if (from.fileClass === "central" && importsAuthorityConstructor && !authorityOwnerEdge) diagnostics.push(diagnostic("fail", "central-imports-authority-constructor", edge.from, `Central code cannot import an authority constructor outside its exact owner edge: ${edge.to}`));
    if (from.fileClass === "generated" && importsAuthorityConstructor && !authorityOwnerEdge) diagnostics.push(diagnostic("fail", "generated-imports-authority-constructor", edge.from, `Generated code cannot import an authority constructor outside its exact generated owner edge: ${edge.to}`));
    if (from.fileClass === "family" && to.fileClass === "family" && from.path.split("/")[1] !== to.path.split("/")[1]) diagnostics.push(diagnostic("fail", "family-imports-family", edge.from, `Family imports another Family internals ${edge.to}`));
    if (from.fileClass === "strategy" && to.fileClass === "strategy" && from.path.split("/")[1] !== to.path.split("/")[1]) diagnostics.push(diagnostic("fail", "strategy-imports-strategy", edge.from, `Strategy imports another Strategy internals ${edge.to}`));
    if (from.fileClass === "strategy" && (to.fileClass === "family" || to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector")) diagnostics.push(diagnostic("fail", "strategy-imports-family-or-acceptance", edge.from, `Strategy cannot import Family or acceptance implementation ${edge.to}`));
    if (from.fileClass === "strategy" && to.fileClass === "production-runtime") diagnostics.push(diagnostic("fail", "strategy-imports-runtime", edge.from, `Strategy cannot import production runtime or worker implementation ${edge.to}`));
    if (from.fileClass === "strategy" && (to.fileClass === "authoring" || to.fileClass === "reference-only")) diagnostics.push(diagnostic("fail", "strategy-imports-noncontract", edge.from, `Strategy cannot import authoring or reference-only implementation ${edge.to}`));
    if (from.fileClass === "valuation-owner" && to.fileClass === "central" && (isCentralInternalPath(to.path) || !isValuationOwnerAllowedCentralImport(to.path))) diagnostics.push(diagnostic("fail", "valuation-owner-imports-forbidden-central", edge.from, `Valuation owner dependencies are default-deny; only neutral valuation/runtime contracts and canonical codecs are allowed: ${edge.to}`));
    if (from.fileClass === "valuation-owner" && ["production-runtime", "family", "strategy", "acceptance-pure-core", "acceptance-collector", "authoring", "generated", "reference-only"].includes(to.fileClass)) diagnostics.push(diagnostic("fail", "valuation-owner-imports-forbidden-layer", edge.from, `Valuation owner cannot import ${to.fileClass} source ${edge.to}`));
    if (from.fileClass === "valuation-owner" && to.fileClass === "valuation-owner" && from.path.split("/")[1] !== to.path.split("/")[1]) diagnostics.push(diagnostic("fail", "valuation-owner-imports-valuation-owner", edge.from, `Valuation owner imports another owner implementation ${edge.to}`));
    if (from.fileClass === "generated" && to.fileClass === "authoring") diagnostics.push(diagnostic("fail", "generated-imports-authoring", edge.from, `Generated output cannot import authoring code ${edge.to}`));
    if (from.fileClass === "generated" && (to.fileClass === "family" || to.fileClass === "strategy") && !(isGeneratedComposition(from.path) && isPublicPluginEntry(to))) diagnostics.push(diagnostic("fail", "generated-imports-plugin-internal", edge.from, `Only generated composition may import a Family/Strategy public entry ${edge.to}`));
    if (from.fileClass === "generated" && to.fileClass === "valuation-owner" && !(from.path === VALUATION_OWNER_RUNTIME_COMPOSITION_PATH && isValuationOwnerRuntimeEntry(to))) diagnostics.push(diagnostic("fail", "generated-imports-valuation-owner-internal", edge.from, `Only the generated valuation-owner registry may import an owner runtime entry ${edge.to}`));
    if (
      to.fileClass === "generated" &&
      from.fileClass !== "central" &&
      from.fileClass !== "generated" &&
      !productionReleaseRuntimeImport &&
      !qualifiedReleaseRunnerImport &&
      !generatedReleaseAuthorityImport
    ) {
      diagnostics.push(diagnostic("fail", "generated-consumer-boundary", edge.from, `Only generated modules may compose generated artifacts, and apps may consume runtime composition only: ${edge.to}`));
    }
  }
  for (const requiredEdge of REQUIRED_AUTHORITY_IMPORT_EDGES) {
    const [fromPath, toPath] = requiredEdge.split("\u2192");
    if (!byPath.has(fromPath) || !byPath.has(toPath)) continue;
    if (!edges.some((edge) => edge.from === fromPath && edge.to === toPath)) {
      diagnostics.push(diagnostic(
        "fail",
        "authority-consumer-edge-missing",
        fromPath,
        `Required owner-issued authority consumer edge is missing: ${fromPath} → ${toPath}`,
      ));
    }
  }
  if (byPath.has(PRE_RELEASE_FACT_LOG_PATH) && byPath.has(PRE_RELEASE_ACTIVE_READY_GRAPH_OBSERVER_PATH)
    && !edges.some(edge => edge.from === PRE_RELEASE_FACT_LOG_PATH
      && edge.to === PRE_RELEASE_ACTIVE_READY_GRAPH_OBSERVER_PATH)) {
    diagnostics.push(diagnostic(
      "fail",
      "pre-release-ready-graph-observer-edge-missing",
      PRE_RELEASE_FACT_LOG_PATH,
      "Pre-release fact log must retain the exact public root-owned Ready Graph observer edge",
    ));
  }
  if (byPath.has(PRE_RELEASE_FACT_LOG_PATH) && byPath.has(PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_PATH)
    && !edges.some(edge => edge.from === PRE_RELEASE_FACT_LOG_PATH
      && edge.to === PRE_RELEASE_TERMINAL_PHYSICAL_OBSERVER_PATH)) {
    diagnostics.push(diagnostic(
      "fail",
      "pre-release-terminal-physical-observer-edge-missing",
      PRE_RELEASE_FACT_LOG_PATH,
      "Pre-release FactLog must retain the exact owner-issued terminal physical observer edge",
    ));
  }
  if (byPath.has(FINAL_PRE_RELEASE_RUNNER_PATH) && byPath.has(PRE_RELEASE_FACT_LOG_PATH)
    && !edges.some(edge => edge.from === FINAL_PRE_RELEASE_RUNNER_PATH
      && edge.to === PRE_RELEASE_FACT_LOG_PATH)) {
    diagnostics.push(diagnostic(
      "fail",
      "final-pre-release-fact-log-edge-missing",
      FINAL_PRE_RELEASE_RUNNER_PATH,
      "Final pre-release must execute and persist the FactLog before thaw",
    ));
  }
}

function sha256Bytes(bytes: Buffer | string): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function npmPackageRootForFile(filePath: string): string | null {
  const normalized = posixPath(resolve(filePath));
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const prefix = normalized.slice(0, markerIndex + marker.length);
  const remainder = normalized.slice(markerIndex + marker.length);
  const parts = remainder.split("/");
  const packageParts = parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  return packageParts.length > 0 && packageParts.every(Boolean) ? `${prefix}${packageParts.join("/")}` : null;
}

function npmLockPathForPackage(root: string, packageRoot: string): string | null {
  if (!isInside(root, packageRoot)) return null;
  const relativePackageRoot = rel(root, packageRoot);
  return relativePackageRoot.startsWith("node_modules/") ? relativePackageRoot : null;
}

function exactPackageLockOwner(
  npmLock: NpmLockFacts,
  packageName: string,
  packageVersion: string,
): NpmLockRecordFacts | null {
  const suffix = `node_modules/${packageName}`;
  const matches = [...npmLock.records.values()].filter(record =>
    (record.path === suffix || record.path.endsWith(`/${suffix}`))
    && record.version === packageVersion);
  return matches.length === 1 ? matches[0]! : null;
}

function externalCompilerInput(
  root: string,
  physicalRoot: string,
  filePath: string,
  compilerText: string | null,
  kind: "npm" | "typescript-lib" | "typescript-compiler",
  npmLock: NpmLockFacts,
  diagnostics: BoundaryDiagnostic[],
): ImplementationCompilerInput | null {
  const logicalPath = resolve(filePath);
  const packageRoot = npmPackageRootForFile(logicalPath);
  if (!packageRoot) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-owner-unproven", rel(root, logicalPath), "External TypeScript compiler input has no npm package owner"));
    return null;
  }
  let physicalPath: string;
  try {
    physicalPath = resolve(realpathSync(logicalPath));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-unreadable", ".", String(error)));
    return null;
  }
  const manifestPath = join(packageRoot, "package.json");
  let manifestBytes: Buffer;
  let manifest: Record<string, unknown>;
  try {
    manifestBytes = readFileSync(manifestPath);
    const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("object expected");
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-package-manifest", rel(root, physicalPath), String(error)));
    return null;
  }
  const packageName = typeof manifest.name === "string" ? manifest.name : null;
  const packageVersion = typeof manifest.version === "string" ? manifest.version : null;
  if (!packageName || !packageVersion) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-package-identity", rel(root, physicalPath), "External compiler input package.json must contain exact name and version"));
    return null;
  }
  const repositoryLockPathCandidate = npmLockPathForPackage(root, packageRoot) ?? npmLockPathForPackage(physicalRoot, packageRoot);
  const repositoryLockRecord = repositoryLockPathCandidate ? npmLock.records.get(repositoryLockPathCandidate) ?? null : null;
  const repositoryLockPath = repositoryLockRecord === null ? null : repositoryLockPathCandidate;
  const installedPackageOwner = repositoryLockRecord === null
    ? exactPackageLockOwner(npmLock, packageName, packageVersion)
    : null;
  const lockPath = repositoryLockPath ?? (installedPackageOwner
    ? packageName === "typescript"
      ? `@toolchain/${installedPackageOwner.path}`
      : installedPackageOwner.path
    : null);
  const lockRecord = repositoryLockRecord ?? installedPackageOwner;
  if (!lockPath || !lockRecord) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-owner-unproven", rel(root, logicalPath), `Cannot derive the exact lock owner for ${packageName}@${packageVersion}`));
    return null;
  }
  if (lockRecord.version !== packageVersion) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-lock-mismatch", rel(root, physicalPath), `Installed ${packageName}@${packageVersion} does not match exact lock record ${lockPath}`));
    return null;
  }
  const packageRelativePath = posixPath(relative(packageRoot, logicalPath));
  if (!packageRelativePath || packageRelativePath.startsWith("../") || isAbsolute(packageRelativePath)) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-path", rel(root, physicalPath), "External compiler input is outside its owning package"));
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(physicalPath);
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "external-compiler-input-unreadable", rel(root, physicalPath), String(error)));
    return null;
  }
  return {
    kind,
    logicalPath: `npm/${packageName}@${packageVersion}/${packageRelativePath}`,
    blobSha: null,
    packageName,
    packageVersion,
    packageRelativePath,
    packageManifestSha256: sha256Bytes(manifestBytes),
    lockRecordPath: lockPath,
    lockRecordHash: lockRecord.recordHash,
    contentSha256: sha256Bytes(bytes),
    compilerTextSha256: compilerText === null ? null : sha256Bytes(Buffer.from(compilerText, "utf8")),
    byteLength: bytes.byteLength,
  };
}

function collectCompilerInputs(
  root: string,
  program: ts.Program,
  tracked: ReadonlyMap<string, TrackedFile>,
  npmLock: NpmLockFacts,
  diagnostics: BoundaryDiagnostic[],
): ImplementationCompilerInput[] {
  let physicalRoot: string;
  let typescriptCompilerPath: string;
  let typescriptLibRoot: string;
  try {
    physicalRoot = resolve(realpathSync(root));
    typescriptCompilerPath = resolve(realpathSync(ts.sys.getExecutingFilePath()));
    typescriptLibRoot = dirname(resolve(realpathSync(ts.getDefaultLibFilePath(program.getCompilerOptions()))));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "compiler-installation-unreadable", ".", String(error)));
    return [];
  }
  const records = new Map<string, ImplementationCompilerInput>();
  const add = (record: ImplementationCompilerInput | null): void => {
    if (!record) return;
    const previous = records.get(record.logicalPath);
    if (previous && canonical(previous) !== canonical(record)) {
      diagnostics.push(diagnostic("invalid", "compiler-input-logical-path-collision", record.logicalPath, "Two physical compiler inputs claim one logical identity with different bytes"));
      return;
    }
    records.set(record.logicalPath, record);
  };
  for (const source of program.getSourceFiles()) {
    let physicalPath: string;
    try {
      physicalPath = resolve(realpathSync(source.fileName));
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "compiler-input-unreadable", source.fileName, String(error)));
      continue;
    }
    if (isInside(physicalRoot, physicalPath)) {
      const path = rel(physicalRoot, physicalPath);
      const file = tracked.get(path);
      if (file) {
        add({
          kind: "tracked",
          logicalPath: `repo/${path}`,
          blobSha: file.blobSha,
          packageName: null,
          packageVersion: null,
          packageRelativePath: null,
          packageManifestSha256: null,
          lockRecordPath: null,
          lockRecordHash: null,
          contentSha256: file.contentSha256,
          compilerTextSha256: sha256Bytes(Buffer.from(source.text, "utf8")),
          byteLength: file.byteLength,
        });
        continue;
      }
    }
    const defaultLib = isInside(typescriptLibRoot, physicalPath) && /^lib\..*\.d\.ts$/.test(physicalPath.slice(physicalPath.lastIndexOf(sep) + 1));
    add(externalCompilerInput(root, physicalRoot, source.fileName, source.text, defaultLib ? "typescript-lib" : "npm", npmLock, diagnostics));
  }
  add(externalCompilerInput(root, physicalRoot, typescriptCompilerPath, null, "typescript-compiler", npmLock, diagnostics));
  return Array.from(records.values()).sort((a, b) => `${a.kind}|${a.logicalPath}`.localeCompare(`${b.kind}|${b.logicalPath}`));
}

let cachedNodeRuntimeInput: ImplementationCompilerInput | null = null;

function nodeRuntimeInput(): ImplementationCompilerInput {
  if (cachedNodeRuntimeInput !== null) return cachedNodeRuntimeInput;
  const executable = readFileSync(process.execPath);
  const runtimeIdentity = Buffer.from(canonical({
    version: process.version,
    versions: process.versions,
    release: process.release,
    platform: process.platform,
    arch: process.arch,
  }), "utf8");
  cachedNodeRuntimeInput = Object.freeze({
    kind: "node-runtime",
    logicalPath: `runtime/node@${process.version}/${process.platform}-${process.arch}`,
    blobSha: null,
    packageName: "node",
    packageVersion: process.version,
    packageRelativePath: null,
    packageManifestSha256: sha256Bytes(runtimeIdentity),
    lockRecordPath: null,
    lockRecordHash: null,
    contentSha256: sha256Bytes(executable),
    compilerTextSha256: null,
    byteLength: executable.byteLength,
  });
  return cachedNodeRuntimeInput;
}

export function computeProgramInputSetRoot(inputs: readonly ImplementationCompilerInput[]): string {
  return hashDomain("aloha/boundary/program-input-set/v2", [...inputs].sort((a, b) => `${a.kind}|${a.logicalPath}`.localeCompare(`${b.kind}|${b.logicalPath}`)));
}

function hasUniversalGlobalCompilerEffect(source: ts.SourceFile): boolean {
  if (!ts.isExternalModule(source)) return true;
  let globalEffect = false;
  const visit = (node: ts.Node): void => {
    if (globalEffect) return;
    if (ts.isModuleDeclaration(node)) {
      if ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) {
        globalEffect = true;
        return;
      }
    }
    if (ts.isNamespaceExportDeclaration(node)) {
      globalEffect = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return globalEffect;
}

function compilerFileIdentity(fileName: string): string {
  try {
    return resolve(realpathSync(fileName));
  } catch {
    return resolve(fileName);
  }
}

function resolutionModeLabel(mode: ts.ResolutionMode): "import" | "require" | undefined {
  if (mode === ts.ModuleKind.CommonJS) return "require";
  if (mode === ts.ModuleKind.ESNext) return "import";
  return undefined;
}

interface CompilerModuleUsage {
  readonly literal: ts.StringLiteralLike;
  readonly specifier: string;
}

function moduleAugmentationUsages(source: ts.SourceFile): CompilerModuleUsage[] {
  if (!ts.isExternalModule(source)) return [];
  const usages = new Map<string, CompilerModuleUsage>();
  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.GlobalAugmentation) === 0 && ts.isStringLiteral(node.name)) {
      const key = `${node.name.getStart(source)}|${node.name.text}`;
      usages.set(key, { literal: node.name, specifier: node.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return Array.from(usages.values()).sort((a, b) => a.literal.getStart(source) - b.literal.getStart(source) || a.specifier.localeCompare(b.specifier));
}

/**
 * SourceFile.imports is the compiler's resolution list and includes ordinary,
 * dynamic, and ImportTypeNode references.  TypeScript may omit JSDoc imports
 * from that list depending on jsDocParsingMode, so collect those explicitly
 * as well.  The graph is deduplicated by source position and specifier.
 */
function compilerModuleUsages(source: ts.SourceFile): CompilerModuleUsage[] {
  const usages = new Map<string, CompilerModuleUsage>();
  const add = (literal: ts.StringLiteralLike): void => {
    const key = `${literal.getStart(source)}|${literal.text}`;
    usages.set(key, { literal, specifier: literal.text });
  };
  const compilerImports = (source as ts.SourceFile & { imports?: readonly ts.StringLiteralLike[] }).imports ?? [];
  for (const literal of compilerImports) add(literal);
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) add(node.argument.literal);
    for (const tag of ts.getJSDocTags(node)) {
      const type = (tag as ts.JSDocTypeTag).typeExpression?.type;
      if (!type) continue;
      const visitJSDocType = (typeNode: ts.Node): void => {
        if (ts.isImportTypeNode(typeNode) && ts.isLiteralTypeNode(typeNode.argument) && ts.isStringLiteralLike(typeNode.argument.literal)) add(typeNode.argument.literal);
        ts.forEachChild(typeNode, visitJSDocType);
      };
      visitJSDocType(type);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return Array.from(usages.values()).sort((a, b) => a.literal.getStart(source) - b.literal.getStart(source) || a.specifier.localeCompare(b.specifier));
}

interface ModuleAugmentationRoot {
  readonly rootName: string;
  readonly rootPath: string | null;
  readonly targetNames: readonly string[];
}

interface CompilerContext {
  readonly configPath: string;
  readonly options: ts.CompilerOptions;
  readonly rootPaths: readonly string[];
  readonly sourcePaths: readonly string[];
  /** Physical compiler roots are never emitted; stable identities come from collected inputs. */
  readonly universalGlobalRootNames: readonly string[];
  readonly universalGlobalRootPaths: readonly string[];
  readonly moduleAugmentations: readonly ModuleAugmentationRoot[];
  readonly configChain: ImplementationConfigChain;
  readonly tsconfigRoot: string;
  readonly edges: readonly GraphEdge[];
  readonly externalDependencies: readonly string[];
  readonly normalizedOptions: unknown;
}

interface SourceBuildGraphFacts {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly compilerRoot: string;
  readonly externalDependencies: string[];
  readonly contexts: readonly CompilerContext[];
}

function sourceBuildGraph(
  root: string,
  files: readonly TrackedFile[],
  configs: readonly string[],
  packageRoot: string,
  requiredGenerators: ReadonlySet<string>,
  diagnostics: BoundaryDiagnostic[],
): SourceBuildGraphFacts {
  const tracked = new Map(files.map((file) => [file.path, file]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const externalDependencies = new Set<string>();
  const covered = new Set<string>();
  const configRoots: Array<{ path: string; options: unknown; roots: string[] }> = [];
  const contexts: CompilerContext[] = [];
  const repoPhysicalRoot = physicalRoot(root, diagnostics) ?? resolve(root);
  for (const configPath of configs) {
    const result = readTsConfig(root, configPath, files, diagnostics);
    if (!result) continue;
    const programResolver = (result.program as Partial<ProgramWithResolvedModules>).getResolvedModuleFromModuleSpecifier;
    if (typeof programResolver !== "function") {
      diagnostics.push(diagnostic("invalid", "compiler-program-resolver-unavailable", configPath, "Pinned TypeScript Program does not expose the resolved-module facts used by module augmentation edges"));
    }
    const rootPaths = result.parsed.fileNames
      .map((name) => compilerPath(root, repoPhysicalRoot, name, tracked, diagnostics, "root"))
      .filter((name): name is string => name !== null)
      .sort();
    const normalizedOptions = compilerOptionsForDigest(root, result.parsed.options, configPath, diagnostics);
    configRoots.push({ path: configPath, options: normalizedOptions, roots: rootPaths });
    for (const path of rootPaths) covered.add(path);
    const contextEdges: GraphEdge[] = [];
    const contextExternalDependencies = new Set<string>();
    const augmentationTargetsBySource = new Map<string, readonly string[]>();
    const programSourceFiles = result.program.getSourceFiles();
    const sourceFiles: ts.SourceFile[] = [];
    const typeScriptLibRoot = dirname(resolve(realpathSync(ts.getDefaultLibFilePath(result.parsed.options))));
    for (const source of programSourceFiles) {
      const lexical = resolve(source.fileName);
      if (isInside(root, lexical)) {
        // Installed packages may intentionally be linked to an external
        // store; they are accounted for as locked external compiler inputs.
        if (lexical.includes(`${sep}node_modules${sep}`)) continue;
        const sourcePath = compilerPath(root, repoPhysicalRoot, source.fileName, tracked, diagnostics, "source");
        if (sourcePath && !sourcePath.startsWith("node_modules/")) sourceFiles.push(source);
        continue;
      }
      let physical: string;
      try {
        physical = resolve(realpathSync(lexical));
      } catch (error) {
        diagnostics.push(diagnostic("invalid", "compiler-source-unreadable", posixPath(relative(root, lexical)), String(error)));
        continue;
      }
      const allowedExternal = physical.startsWith(`${typeScriptLibRoot}${sep}`) || lexical.includes(`${sep}node_modules${sep}`) || physical.includes(`${sep}node_modules${sep}`);
      if (!allowedExternal) diagnostics.push(diagnostic("invalid", "compiler-source-outside-root", posixPath(relative(root, lexical)), "Program consumed a source outside the exact repository root"));
    }
    for (const source of sourceFiles) {
      const sourcePath = compilerPath(root, repoPhysicalRoot, source.fileName, tracked, diagnostics, "source");
      if (!sourcePath) continue;
      if (!tracked.has(sourcePath)) {
        diagnostics.push(diagnostic("invalid", "compiler-source-not-tracked", sourcePath, "Compiler graph contains a source not present in exact Git tree"));
        continue;
      }
      covered.add(sourcePath);
      nodes.push({ path: sourcePath, configPath, root: rootPaths.includes(sourcePath) });
      const sourceFileMeta = tracked.get(sourcePath)!;
      const testOrFixture = /(?:^|\/)(?:test|tests|fixture|fixtures)\//.test(sourcePath) || /(?:^|\.)(?:test|spec)\.[^.]+$/.test(sourcePath);
      const pureAcceptanceCore = sourceFileMeta.fileClass === "acceptance-pure-core" && !testOrFixture;
      const forbidEnvironmentIo = sourceFileMeta.fileClass !== "authoring"
        && sourceFileMeta.fileClass !== "acceptance-collector"
        && sourceFileMeta.fileClass !== "reference-only"
        && !testOrFixture
        && !CHILD_PROCESS_RUNTIME_OWNER_PATHS.has(sourcePath);
      const allowDynamicLoaders = sourceFileMeta.fileClass === "authoring" || testOrFixture;
      const scan = inspectSourceText(sourcePath, readFileSync(source.fileName, "utf8"), {
        pureAcceptanceCore,
        forbidEnvironmentIo,
        allowDynamicLoaders,
        allowExternalDeploymentBundleLoader: sourcePath === EXTERNAL_DEPLOYMENT_LOADER_PATH,
      });
      diagnostics.push(...scan.diagnostics);
      for (const usage of compilerModuleUsages(source)) {
        const resolutionMode = ts.getModeForUsageLocation(source, usage.literal, result.parsed.options);
        const target = resolveSpecifier(root, source.fileName, usage.specifier, result.parsed.options, tracked, externalDependencies, diagnostics, usage.literal.getStart(source), resolutionMode);
        if (target) {
          const modeLabel = resolutionModeLabel(resolutionMode);
          const edge: GraphEdge = modeLabel
            ? { from: sourcePath, to: target, specifier: usage.specifier, resolutionMode: modeLabel }
            : { from: sourcePath, to: target, specifier: usage.specifier };
          edges.push(edge);
          contextEdges.push(edge);
          if (target.startsWith("@external/")) contextExternalDependencies.add(usage.specifier);
        }
      }
      const augmentationTargetNames = new Set<string>();
      for (const usage of moduleAugmentationUsages(source)) {
        const resolutionMode = ts.getModeForUsageLocation(source, usage.literal, result.parsed.options);
        const observedResolution = typeof programResolver === "function"
          ? programResolver.call(result.program, usage.literal, source)
          : undefined;
        if (!observedResolution?.resolvedModule) {
          diagnostics.push(diagnostic("invalid", "module-augmentation-target-unresolved", sourcePath, `Cannot prove the same-Program target of module augmentation ${usage.specifier}`, usage.literal.getStart(source)));
          continue;
        }
        augmentationTargetNames.add(compilerFileIdentity(observedResolution.resolvedModule.resolvedFileName));
        const target = resolveSpecifier(
          root,
          source.fileName,
          usage.specifier,
          result.parsed.options,
          tracked,
          externalDependencies,
          diagnostics,
          usage.literal.getStart(source),
          resolutionMode,
          observedResolution,
        );
        if (target !== null) {
          const modeLabel = resolutionModeLabel(resolutionMode);
          const edge: GraphEdge = modeLabel
            ? { from: sourcePath, to: target, specifier: usage.specifier, resolutionMode: modeLabel }
            : { from: sourcePath, to: target, specifier: usage.specifier };
          edges.push(edge);
          contextEdges.push(edge);
          if (target.startsWith("@external/")) contextExternalDependencies.add(usage.specifier);
        }
      }
      augmentationTargetsBySource.set(compilerFileIdentity(source.fileName), Array.from(augmentationTargetNames).sort());
      // The compiler also consumes triple-slash and type-reference edges.  They
      // are not all represented by import declarations, but are still part of
      // the Program and therefore part of the compiler-visible closure.
      for (const reference of source.referencedFiles) {
        const target = resolveSpecifier(root, source.fileName, reference.fileName, result.parsed.options, tracked, externalDependencies, diagnostics, reference.pos);
        if (target) {
          const edge = { from: sourcePath, to: target, specifier: `/// <reference path="${reference.fileName}">` };
          edges.push(edge);
          contextEdges.push(edge);
        }
      }
      for (const reference of source.typeReferenceDirectives) {
        const target = resolveTypeReference(root, source.fileName, reference.fileName, result.parsed.options, tracked, externalDependencies, diagnostics, reference.pos);
        if (target) {
          const edge = { from: sourcePath, to: target, specifier: `/// <reference types="${reference.fileName}">` };
          edges.push(edge);
          contextEdges.push(edge);
          if (target.startsWith("@external/")) contextExternalDependencies.add(reference.fileName);
        }
      }
      for (const reference of source.libReferenceDirectives) {
        const dependency = `typescript-lib:${reference.fileName}`;
        const edge = {
          from: sourcePath,
          to: `@external/${dependency}`,
          specifier: `/// <reference lib="${reference.fileName}">`,
        };
        edges.push(edge);
        contextEdges.push(edge);
        externalDependencies.add(dependency);
        contextExternalDependencies.add(dependency);
      }
    }
    const contextSourcePaths = sourceFiles.map((source) => compilerPath(root, repoPhysicalRoot, source.fileName, tracked, diagnostics, "source")).filter((path): path is string => path !== null).sort();
    const universalGlobalRootNames = sourceFiles
      .filter((source) => hasUniversalGlobalCompilerEffect(source))
      .map((source) => resolve(source.fileName))
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort();
    const universalGlobalRootPaths = universalGlobalRootNames
      .map((name) => rel(root, name))
      .filter((path) => tracked.has(path))
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort();
    const moduleAugmentations = sourceFiles
      .map((source): ModuleAugmentationRoot | null => {
        const targetNames = augmentationTargetsBySource.get(compilerFileIdentity(source.fileName)) ?? [];
        if (targetNames.length === 0) return null;
        const rootName = resolve(source.fileName);
        const candidatePath = rel(root, rootName);
        return {
          rootName,
          rootPath: tracked.has(candidatePath) ? candidatePath : null,
          targetNames,
        };
      })
      .filter((augmentation): augmentation is ModuleAugmentationRoot => augmentation !== null)
      .sort((a, b) => a.rootName.localeCompare(b.rootName));
    const uniqueContextEdges = Array.from(new Map(contextEdges.map((edge) => [`${edge.from}|${edge.to}|${edge.specifier}|${edge.resolutionMode ?? ""}`, edge])).values())
      .sort((a, b) => `${a.from}|${a.to}|${a.specifier}|${a.resolutionMode ?? ""}`.localeCompare(`${b.from}|${b.to}|${b.specifier}|${b.resolutionMode ?? ""}`));
    contexts.push({
      configPath,
      options: result.parsed.options,
      rootPaths,
      sourcePaths: contextSourcePaths,
      universalGlobalRootNames,
      universalGlobalRootPaths,
      moduleAugmentations,
      configChain: result.configChain.chain,
      tsconfigRoot: result.configChain.root,
      edges: uniqueContextEdges,
      externalDependencies: Array.from(contextExternalDependencies).sort(),
      normalizedOptions,
    });
  }
  const sourceFiles = files.filter((file) => file.language === "typescript" || file.language === "javascript");
  for (const file of sourceFiles) {
    if (!covered.has(file.path)) diagnostics.push(diagnostic("invalid", "source-not-in-tsconfig", file.path, "Tracked TS/JS source is excluded from every real compiler config"));
  }
  const uniqueNodes = Array.from(new Map(nodes.map((node) => [`${node.configPath}|${node.path}`, node])).values()).sort((a, b) => `${a.configPath}|${a.path}`.localeCompare(`${b.configPath}|${b.path}`));
  const uniqueEdges = Array.from(new Map(edges.map((edge) => [`${edge.from}|${edge.to}|${edge.specifier}|${edge.resolutionMode ?? ""}`, edge])).values()).sort((a, b) => `${a.from}|${a.to}|${a.specifier}|${a.resolutionMode ?? ""}`.localeCompare(`${b.from}|${b.to}|${b.specifier}|${b.resolutionMode ?? ""}`));
  for (const generator of requiredGenerators) {
    if (!uniqueNodes.some((node) => node.path === generator)) diagnostics.push(diagnostic("invalid", "generator-outside-compiler-graph", generator, "Every generated output generator must be present in the pinned compiler graph"));
  }
  validateDependencyBoundaries(files, uniqueEdges, diagnostics, root);
  const compilerRoot = hashDomain("aloha/boundary/compiler-graph/v1", {
    version: ts.version,
    configs: configRoots.map((config) => ({ path: config.path, options: config.options, roots: [...config.roots].sort() })),
    packageRoot,
    externalDependencies: Array.from(externalDependencies).sort(),
    nodes: uniqueNodes,
    edges: uniqueEdges,
  });
  return { nodes: uniqueNodes, edges: uniqueEdges, compilerRoot, externalDependencies: Array.from(externalDependencies).sort(), contexts };
}

interface ClosureEntrypoint {
  readonly id: string;
  readonly path: string;
  readonly configPath: string;
  readonly kind: "compiler-root" | "package-entrypoint";
  readonly packageName: string | null;
  readonly packageManifestPath: string | null;
}

function closureFiles(
  paths: ReadonlySet<string>,
  tracked: ReadonlyMap<string, TrackedFile>,
  diagnostics: BoundaryDiagnostic[],
): ImplementationClosureFile[] {
  const result: ImplementationClosureFile[] = [];
  for (const path of Array.from(paths).sort()) {
    const file = tracked.get(path);
    if (!file) {
      diagnostics.push(diagnostic("invalid", "closure-file-not-tracked", path, "Compiler-visible closure contains a file outside the exact Git denominator"));
      continue;
    }
    result.push({ path: file.path, blobSha: file.blobSha, contentSha256: file.contentSha256, byteLength: file.byteLength });
  }
  return result;
}

function implementationClosureDigest(closure: Omit<ImplementationClosure, "closureDigest">): string {
  return hashDomain("aloha/boundary/implementation-closure/v1", {
    entrypoint: closure.entrypoint,
    entrypointId: closure.entrypointId,
    kind: closure.kind,
    packageName: closure.packageName,
    packageManifestPath: closure.packageManifestPath,
    configPath: closure.configPath,
    tsconfigRoot: closure.tsconfigRoot,
    configChain: closure.configChain,
    optionsRoot: closure.optionsRoot,
    programInputs: closure.programInputs,
    programInputSetRoot: closure.programInputSetRoot,
    typescriptVersion: closure.typescriptVersion,
    packageManifestRoot: closure.packageManifestRoot,
    externalDependencyRoot: closure.externalDependencyRoot,
    files: closure.files,
    edges: closure.edges,
  });
}

function packageManifestRootForClosure(
  paths: ReadonlySet<string>,
  packageManifestPath: string | null,
  tracked: ReadonlyMap<string, TrackedFile>,
): string {
  const manifestPaths = new Set<string>();
  if (tracked.has("package.json")) manifestPaths.add("package.json");
  if (packageManifestPath) manifestPaths.add(packageManifestPath);
  for (const path of paths) {
    let directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    while (true) {
      const candidate = directory ? `${directory}/package.json` : "package.json";
      if (tracked.has(candidate)) {
        manifestPaths.add(candidate);
        break;
      }
      if (!directory) break;
      directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
    }
  }
  return hashDomain("aloha/boundary/package-manifests/closure/v1", Array.from(manifestPaths).sort().map((path) => {
    const file = tracked.get(path)!;
    return { path, blobSha: file.blobSha, contentSha256: file.contentSha256, byteLength: file.byteLength };
  }));
}

interface ExternalDependencyOwner {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly lockRecordPath: string;
  readonly lockRecordHash: string;
}

function externalOwnersForClosure(
  root: string,
  edges: readonly GraphEdge[],
  options: ts.CompilerOptions,
  npmLock: NpmLockFacts,
  diagnostics: BoundaryDiagnostic[],
): ExternalDependencyOwner[] {
  const owners = new Map<string, ExternalDependencyOwner>();
  let physicalRoot: string;
  try {
    physicalRoot = resolve(realpathSync(root));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "external-edge-root-unreadable", ".", String(error)));
    return [];
  }
  for (const edge of edges.filter((candidate) => candidate.to.startsWith("@external/"))) {
    const dependency = edge.to.slice("@external/".length);
    if (dependency.startsWith("node:") || dependency.startsWith("typescript-lib:")) continue;
    const containingFile = abs(root, edge.from);
    const typeReference = edge.specifier.startsWith("/// <reference types=");
    const resolvedFileName = typeReference
      ? ts.resolveTypeReferenceDirective(dependency, containingFile, options, ts.sys).resolvedTypeReferenceDirective?.resolvedFileName
      : ts.resolveModuleName(
        dependency,
        containingFile,
        options,
        ts.sys,
        undefined,
        undefined,
        edge.resolutionMode === "require" ? ts.ModuleKind.CommonJS : edge.resolutionMode === "import" ? ts.ModuleKind.ESNext : undefined,
      ).resolvedModule?.resolvedFileName;
    if (!resolvedFileName) {
      diagnostics.push(diagnostic("invalid", "external-edge-owner-unresolved", edge.from, `Cannot resolve an exact npm owner for external dependency ${dependency}`));
      continue;
    }
    const logicalPackageRoot = npmPackageRootForFile(resolve(resolvedFileName));
    if (logicalPackageRoot === null) {
      diagnostics.push(diagnostic("invalid", "external-edge-owner-unproven", edge.from, `External dependency ${dependency} resolved to ${rel(physicalRoot, resolve(resolvedFileName))} but has no npm package owner`));
      continue;
    }
    let manifest: Readonly<Record<string, unknown>>;
    try {
      const decoded: unknown = JSON.parse(readFileSync(join(logicalPackageRoot, "package.json"), "utf8"));
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError("package manifest object expected");
      manifest = decoded as Readonly<Record<string, unknown>>;
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "external-edge-owner-unproven", edge.from, `Cannot read exact package identity for ${dependency}: ${String(error)}`));
      continue;
    }
    const packageName = typeof manifest.name === "string" ? manifest.name : null;
    const packageVersion = typeof manifest.version === "string" ? manifest.version : null;
    if (packageName === null || packageVersion === null) {
      diagnostics.push(diagnostic("invalid", "external-edge-owner-unproven", edge.from, `External dependency ${dependency} has no exact package name/version`));
      continue;
    }
    const repositoryLockPathCandidate = npmLockPathForPackage(physicalRoot, logicalPackageRoot);
    const repositoryLockRecord = repositoryLockPathCandidate ? npmLock.records.get(repositoryLockPathCandidate) ?? null : null;
    const repositoryLockPath = repositoryLockRecord === null ? null : repositoryLockPathCandidate;
    const installedPackageOwner = repositoryLockRecord === null
      ? exactPackageLockOwner(npmLock, packageName, packageVersion)
      : null;
    const lockRecordPath = repositoryLockPath ?? installedPackageOwner?.path ?? null;
    const lockRecord = repositoryLockRecord ?? installedPackageOwner;
    if (!lockRecordPath || !lockRecord || lockRecord.version !== packageVersion) {
      diagnostics.push(diagnostic("invalid", "external-edge-owner-unproven", edge.from, `External dependency ${dependency} resolved to ${rel(physicalRoot, resolve(resolvedFileName))} but ${packageName}@${packageVersion} has no exact repository lock owner`));
      continue;
    }
    const owner = {
      packageName,
      packageVersion,
      lockRecordPath,
      lockRecordHash: lockRecord.recordHash,
    };
    owners.set(`${lockRecordPath}:${lockRecord.recordHash}`, owner);
  }
  return Array.from(owners.values()).sort((a, b) => `${a.lockRecordPath}:${a.lockRecordHash}`.localeCompare(`${b.lockRecordPath}:${b.lockRecordHash}`));
}

function externalDependencyRootForClosure(
  edges: readonly GraphEdge[],
  programInputs: readonly ImplementationCompilerInput[],
  edgeOwners: readonly ExternalDependencyOwner[],
): string {
  const dependencies = Array.from(new Set(edges.filter((edge) => edge.to.startsWith("@external/")).map((edge) => edge.specifier))).sort();
  const inputOwners: ExternalDependencyOwner[] = programInputs
    .filter((input) => input.packageName !== null && input.packageVersion !== null && input.lockRecordPath !== null && input.lockRecordHash !== null)
    .map((input) => ({
      packageName: input.packageName!,
      packageVersion: input.packageVersion!,
      lockRecordPath: input.lockRecordPath!,
      lockRecordHash: input.lockRecordHash!,
    }));
  const owners = Array.from(new Map([...inputOwners, ...edgeOwners]
    .map((owner) => [`${owner.lockRecordPath}:${owner.lockRecordHash}`, owner])).values())
    .sort((a, b) => `${a.lockRecordPath}:${a.lockRecordHash}`.localeCompare(`${b.lockRecordPath}:${b.lockRecordHash}`));
  return hashDomain("aloha/boundary/external-dependencies/closure/v3", {
    dependencies,
    owners,
  });
}

interface ProgramWithResolvedModules extends ts.Program {
  /** Present on the exact pinned TypeScript runtime; fail closed if removed. */
  getResolvedModuleFromModuleSpecifier(
    moduleSpecifier: ts.StringLiteralLike,
    sourceFile?: ts.SourceFile,
  ): ts.ResolvedModuleWithFailedLookupLocations | undefined;
}

function isolatedProgramEdges(
  root: string,
  repoPhysicalRoot: string,
  program: ts.Program,
  options: ts.CompilerOptions,
  tracked: ReadonlyMap<string, TrackedFile>,
  allowedPaths: ReadonlySet<string>,
  diagnostics: BoundaryDiagnostic[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const externalDependencies = new Set<string>();
  const programResolver = (program as Partial<ProgramWithResolvedModules>).getResolvedModuleFromModuleSpecifier;
  if (typeof programResolver !== "function") {
    diagnostics.push(diagnostic("invalid", "compiler-program-resolver-unavailable", ".", "Pinned TypeScript Program does not expose the resolved-module facts used by the isolated closure"));
    return [];
  }
  for (const source of program.getSourceFiles()) {
    const lexical = resolve(source.fileName);
    if (!isInside(root, lexical) || lexical.includes(`${sep}node_modules${sep}`)) continue;
    const candidatePath = rel(root, lexical);
    if (!allowedPaths.has(candidatePath)) continue;
    const sourcePath = compilerPath(root, repoPhysicalRoot, source.fileName, tracked, diagnostics, "source");
    if (sourcePath === null || sourcePath.startsWith("node_modules/") || !allowedPaths.has(sourcePath)) continue;
    for (const usage of compilerModuleUsages(source)) {
      const resolutionMode = ts.getModeForUsageLocation(source, usage.literal, options);
      const observedResolution = programResolver.call(program, usage.literal, source) ?? { resolvedModule: undefined };
      const target = resolveSpecifier(root, source.fileName, usage.specifier, options, tracked, externalDependencies, diagnostics, usage.literal.getStart(source), resolutionMode, observedResolution);
      if (target === null) continue;
      const modeLabel = resolutionModeLabel(resolutionMode);
      edges.push(modeLabel
        ? { from: sourcePath, to: target, specifier: usage.specifier, resolutionMode: modeLabel }
        : { from: sourcePath, to: target, specifier: usage.specifier });
    }
    for (const usage of moduleAugmentationUsages(source)) {
      const resolutionMode = ts.getModeForUsageLocation(source, usage.literal, options);
      const observedResolution = programResolver.call(program, usage.literal, source);
      if (!observedResolution?.resolvedModule) {
        diagnostics.push(diagnostic("invalid", "module-augmentation-target-unresolved", sourcePath, `Cannot prove the same-Program target of module augmentation ${usage.specifier}`, usage.literal.getStart(source)));
        continue;
      }
      const target = resolveSpecifier(root, source.fileName, usage.specifier, options, tracked, externalDependencies, diagnostics, usage.literal.getStart(source), resolutionMode, observedResolution);
      if (target === null) continue;
      const modeLabel = resolutionModeLabel(resolutionMode);
      edges.push(modeLabel
        ? { from: sourcePath, to: target, specifier: usage.specifier, resolutionMode: modeLabel }
        : { from: sourcePath, to: target, specifier: usage.specifier });
    }
    for (const reference of source.referencedFiles) {
      const target = resolveSpecifier(root, source.fileName, reference.fileName, options, tracked, externalDependencies, diagnostics, reference.pos);
      if (target !== null) edges.push({ from: sourcePath, to: target, specifier: `/// <reference path="${reference.fileName}">` });
    }
    for (const reference of source.typeReferenceDirectives) {
      const target = resolveTypeReference(root, source.fileName, reference.fileName, options, tracked, externalDependencies, diagnostics, reference.pos);
      if (target !== null) edges.push({ from: sourcePath, to: target, specifier: `/// <reference types="${reference.fileName}">` });
    }
    for (const reference of source.libReferenceDirectives) {
      edges.push({
        from: sourcePath,
        to: `@external/typescript-lib:${reference.fileName}`,
        specifier: `/// <reference lib="${reference.fileName}">`,
      });
    }
  }
  return Array.from(new Map(edges.map((edge) => [
    `${edge.from}|${edge.to}|${edge.specifier}|${edge.resolutionMode ?? ""}`,
    edge,
  ])).values()).sort((a, b) =>
    `${a.from}|${a.to}|${a.specifier}|${a.resolutionMode ?? ""}`.localeCompare(
      `${b.from}|${b.to}|${b.specifier}|${b.resolutionMode ?? ""}`,
    ));
}

/**
 * Create one isolated compiler observation.  The host and every SourceFile it
 * owns are scoped to the returned Program, so completing one root cannot keep
 * another root's AST graph alive or contaminate its module-resolution state.
 */
function createIsolatedProgram(
  options: ts.CompilerOptions,
  rootNames: readonly string[],
): ts.Program {
  const host = ts.createCompilerHost(options);
  return ts.createProgram({ rootNames: [...rootNames], options, host });
}

function buildImplementationClosures(
  root: string,
  files: readonly TrackedFile[],
  contexts: readonly CompilerContext[],
  packageEntrypoints: readonly PackageEntrypoint[],
  lockFiles: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
  selectedEntrypointPaths?: ReadonlySet<string>,
): ImplementationClosure[] {
  // A TypeScript Program owns the complete AST graph for its root set.  It is
  // therefore an entry-local observation, never a CompilerContext member or a
  // closure receipt field.  Keep only the final Program needed to derive this
  // entry's immutable inputs/edges, and drop that reference before advancing
  // to the next entry.  In particular, augmentation probes must not populate
  // a cross-entry Program cache.
  const tracked = new Map(files.map((file) => [file.path, file]));
  const repoPhysicalRoot = physicalRoot(root, diagnostics) ?? resolve(root);
  const entrypoints: ClosureEntrypoint[] = [];
  for (const context of contexts) {
    for (const path of context.rootPaths) {
      if (selectedEntrypointPaths !== undefined && !selectedEntrypointPaths.has(path)) continue;
      const file = tracked.get(path);
      if (file?.language !== "typescript" && file?.language !== "javascript") continue;
      entrypoints.push({ id: `compiler-root:${context.configPath}:${path}`, path, configPath: context.configPath, kind: "compiler-root", packageName: null, packageManifestPath: null });
    }
  }
  for (const entry of packageEntrypoints) {
    if (selectedEntrypointPaths !== undefined && !selectedEntrypointPaths.has(entry.path)) continue;
    const matchingContexts = contexts.filter((context) => context.sourcePaths.includes(entry.path));
    if (matchingContexts.length === 0) {
      diagnostics.push(diagnostic("invalid", "package-entrypoint-not-compiler-visible", entry.manifestPath, `Public package entrypoint ${entry.subpath} is not present in a real TypeScript Program`));
      continue;
    }
    for (const context of matchingContexts) {
      entrypoints.push({
        id: packageEntrypointCompilerIdentityV1(entry.id, context.configPath),
        path: entry.path,
        configPath: context.configPath,
        kind: "package-entrypoint",
        packageName: entry.packageName,
        packageManifestPath: entry.manifestPath,
      });
    }
  }
  const uniqueEntrypoints = Array.from(new Map(entrypoints.map((entry) => [entry.id, entry])).values())
    .sort((a, b) => a.id.localeCompare(b.id));
  if (uniqueEntrypoints.length === 0) return [];
  const npmLock = readNpmLockFacts(root, lockFiles, diagnostics);
  const result: ImplementationClosure[] = [];
  const executionEntrypoints = [...uniqueEntrypoints].sort((a, b) =>
    `${a.configPath}|${a.id}`.localeCompare(`${b.configPath}|${b.id}`));
  for (const entry of executionEntrypoints) {
    const context = contexts.find((candidate) => candidate.configPath === entry.configPath && candidate.sourcePaths.includes(entry.path));
    if (!context) {
      diagnostics.push(diagnostic("invalid", "closure-context-missing", entry.path, `No compiler context can provide entrypoint ${entry.id}`));
      continue;
    }
    const selectedAugmentationRoots = new Set<string>();
    let entryProgram: ts.Program | undefined;
    while (true) {
      const entryRootNames = Array.from(new Set([
        abs(root, entry.path),
        ...context.universalGlobalRootNames,
        ...selectedAugmentationRoots,
      ])).sort();
      // `program` is deliberately block-scoped.  If this augmentation probe
      // is superseded, no reference to its AST graph survives the iteration.
      const program = createIsolatedProgram(context.options, entryRootNames);
      const sourceIdentities = new Set(program.getSourceFiles().map((source) => compilerFileIdentity(source.fileName)));
      const additions = context.moduleAugmentations
        .filter((augmentation) => !selectedAugmentationRoots.has(augmentation.rootName))
        .filter((augmentation) => augmentation.targetNames.some((target) => sourceIdentities.has(target)));
      if (additions.length === 0) {
        entryProgram = program;
        break;
      }
      for (const augmentation of additions) selectedAugmentationRoots.add(augmentation.rootName);
    }
    if (entryProgram === undefined) {
      diagnostics.push(diagnostic("invalid", "closure-program-missing", entry.path, `No isolated TypeScript Program was retained for ${entry.id}`));
      continue;
    }
    const selectedAugmentationPaths = context.moduleAugmentations
      .filter((augmentation) => selectedAugmentationRoots.has(augmentation.rootName) && augmentation.rootPath !== null)
      .map((augmentation) => augmentation.rootPath!);
    const entryRootPaths = Array.from(new Set([
      entry.path,
      ...context.universalGlobalRootPaths,
      ...selectedAugmentationPaths,
    ])).sort();
    const compilerProgramInputs = collectCompilerInputs(root, entryProgram, tracked, npmLock, diagnostics);
    const paths = new Set(compilerProgramInputs
      .filter((input) => input.kind === "tracked" && input.logicalPath.startsWith("repo/"))
      .map((input) => input.logicalPath.slice("repo/".length)));
    if (!paths.has(entry.path)) {
      diagnostics.push(diagnostic("invalid", "closure-entrypoint-input-missing", entry.path, `Entrypoint ${entry.id} was not consumed by its isolated TypeScript Program`));
      entryProgram = undefined;
      continue;
    }
    const edges = isolatedProgramEdges(root, repoPhysicalRoot, entryProgram, context.options, tracked, paths, diagnostics);
    const entryProgramInputs = edges.some((edge) => edge.specifier.startsWith("node:"))
      ? [...compilerProgramInputs, nodeRuntimeInput()].sort((a, b) => `${a.kind}|${a.logicalPath}`.localeCompare(`${b.kind}|${b.logicalPath}`))
      : compilerProgramInputs;
    const optionsRoot = hashDomain("aloha/boundary/compiler-options/v2", {
      configPath: context.configPath,
      options: context.normalizedOptions,
      roots: entryRootPaths,
    });
    const externalOwners = externalOwnersForClosure(root, edges, context.options, npmLock, diagnostics);
    const base: Omit<ImplementationClosure, "closureDigest"> = {
      entrypoint: entry.path,
      entrypointId: entry.id,
      kind: entry.kind,
      packageName: entry.packageName,
      packageManifestPath: entry.packageManifestPath,
      configPath: context.configPath,
      tsconfigRoot: context.tsconfigRoot,
      configChain: context.configChain,
      optionsRoot,
      programInputs: entryProgramInputs,
      programInputSetRoot: computeProgramInputSetRoot(entryProgramInputs),
      typescriptVersion: ts.version,
      packageManifestRoot: packageManifestRootForClosure(paths, entry.packageManifestPath, tracked),
      externalDependencyRoot: externalDependencyRootForClosure(edges, entryProgramInputs, externalOwners),
      files: closureFiles(paths, tracked, diagnostics),
      edges,
    };
    result.push({ ...base, closureDigest: implementationClosureDigest(base) });
    // Do not let the previous entry's AST graph remain reachable while the
    // next isolated root is built.  All receipt facts above are plain records.
    entryProgram = undefined;
  }
  return result.sort((a, b) => a.entrypointId.localeCompare(b.entrypointId));
}

export interface CatalogCompilerBoundaryProjectionOptionsV1 {
  readonly gitRoot?: string;
  readonly modulePaths: readonly string[];
}

export interface CatalogCompilerBoundaryProjectionV1 {
  readonly scannedFileSetRoot: string;
  readonly compilerGraphRoot: string;
  readonly implementationClosures: readonly ImplementationClosure[];
  readonly diagnostics: readonly BoundaryDiagnostic[];
}

/**
 * Collect the exact compiler facts requested by catalog composition without
 * calculating unrelated application/test entrypoint closures.  This is a
 * narrow build-fact projection, never a substitute for the full architecture
 * boundary verdict.  It shares the same indexed bytes, tsconfig graph,
 * compiler inputs, augmentation rules and isolated Program implementation as
 * `runBoundaryGate`.
 */
export function collectCatalogCompilerBoundaryProjection(
  options: CatalogCompilerBoundaryProjectionOptionsV1,
): CatalogCompilerBoundaryProjectionV1 {
  const root = resolve(options.gitRoot ?? fileURLToPath(new URL("../../..", import.meta.url)));
  if (!Array.isArray(options.modulePaths) || options.modulePaths.length === 0) {
    throw new TypeError("catalog compiler projection requires module paths");
  }
  const selected = new Set<string>();
  for (const [index, rawPath] of options.modulePaths.entries()) {
    if (
      typeof rawPath !== "string"
      || rawPath.length === 0
      || rawPath.startsWith("/")
      || rawPath.startsWith(".")
      || rawPath.includes("\\")
      || rawPath.split("/").includes("..")
    ) throw new TypeError(`invalid catalog compiler projection path ${index}`);
    const path = posixPath(rawPath);
    if (selected.has(path)) throw new TypeError(`duplicate catalog compiler projection path ${path}`);
    selected.add(path);
  }
  const diagnostics: BoundaryDiagnostic[] = [];
  const files = readTrackedFiles(root, diagnostics);
  if (files.length === 0) diagnostics.push(diagnostic("invalid", "empty-git-denominator", ".", "An empty or unreadable Git tree cannot supply catalog compiler facts"));
  const packageData = readPackageManifests(root, files, diagnostics);
  const configs = files
    .filter((file) => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file.path) || /(?:^|\/)jsconfig(?:\.[^/]+)?\.json$/.test(file.path))
    .map((file) => file.path)
    .sort();
  if (files.some((file) => file.language === "typescript" || file.language === "javascript") && configs.length === 0) {
    diagnostics.push(diagnostic("invalid", "tsconfig-missing", ".", "TS/JS denominator has no real compiler configuration"));
  }
  const lockFiles = files.filter((file) => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file.path));
  const graphDiagnostics: BoundaryDiagnostic[] = [];
  const graph = sourceBuildGraph(root, files, configs, packageData.rootHash, new Set(), graphDiagnostics);
  // Catalog generation may own an output imported by an unrelated source in
  // the full compiler graph. Such an output cannot exist before the first
  // generation. Defer only that graph-wide bootstrap edge: every selected
  // entry is rebuilt below as an isolated Program, where unresolved imports
  // in its exact closure are reported again and remain invalid. The full
  // boundary keeps the graph-wide rule after generation.
  const trackedPaths = new Set(files.map((file) => file.path));
  diagnostics.push(...graphDiagnostics.filter((item) => {
    if (item.code !== "unresolved-module") return true;
    const prefix = "NodeNext could not resolve ";
    if (!item.message.startsWith(prefix)) return true;
    const specifier = item.message.slice(prefix.length);
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return true;
    const lexicalTarget = posixPath(join(dirname(item.path), specifier));
    return !CATALOG_OUTPUT_PATHS.includes(lexicalTarget) || trackedPaths.has(lexicalTarget);
  }));
  if (graph.externalDependencies.some((specifier) => !specifier.startsWith("node:")) && lockFiles.length === 0) {
    diagnostics.push(diagnostic("invalid", "external-lock-missing", ".", "External package imports require a tracked lockfile bound into the compiler graph"));
  }
  const implementationClosures = buildImplementationClosures(
    root,
    files,
    graph.contexts,
    packageData.entrypoints,
    lockFiles,
    diagnostics,
    selected,
  );
  const finalDiagnostics = uniqueDiagnostics(diagnostics);
  const invalid = finalDiagnostics.filter((item) => item.kind === "invalid");
  if (invalid.length > 0) {
    throw new TypeError(`catalog compiler boundary projection invalid: ${invalid.map((item) => `${item.code}:${item.path}`).join(",")}`);
  }
  return Object.freeze({
    scannedFileSetRoot: hashDomain("aloha/boundary/scanned-file-set/v1", files),
    compilerGraphRoot: graph.compilerRoot,
    implementationClosures: Object.freeze(implementationClosures),
    diagnostics: Object.freeze(finalDiagnostics),
  });
}

/** Pure recomputation; it never treats the stored digest as authority. */
export function recomputeImplementationClosureDigest(
  closure: Omit<ImplementationClosure, "closureDigest"> | ImplementationClosure,
): string {
  if ("closureDigest" in closure) {
    const { closureDigest: _storedDigest, ...facts } = closure;
    return implementationClosureDigest(facts);
  }
  return implementationClosureDigest(closure);
}

/** Exact entrypoint-id lookup; callers must validate the full receipt separately. */
export function findImplementationClosureById(receipt: Pick<BoundaryReceipt, "implementationClosures">, entrypointId: string): ImplementationClosure | null {
  return receipt.implementationClosures.find((closure) => closure.entrypointId === entrypointId) ?? null;
}

/**
 * Project exact compiler facts for a downstream catalog join.  The caller
 * supplies only the named export binding; every digest and entrypoint identity
 * comes from the boundary's compiler-derived closure receipt and is
 * revalidated before it crosses this narrow port.
 */
export function projectCatalogCompilerClosureFacts(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  bindings: readonly CatalogCompilerClosureBindingV1[],
): readonly CatalogCompilerClosureFactV1[] {
  const facts = bindings.map((binding, index) => {
    if (binding === null || typeof binding !== "object") throw new TypeError(`catalog compiler binding ${index} must be an object`);
    const closure = findImplementationClosureById(receipt, binding.entrypointId);
    if (closure === null) throw new TypeError(`catalog compiler closure missing ${binding.entrypointId}`);
    if (closure.entrypoint !== binding.modulePath) throw new TypeError(`catalog compiler binding path mismatch ${binding.entrypointId}`);
    if (computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot) throw new TypeError(`catalog compiler input root mismatch ${binding.entrypointId}`);
    if (recomputeImplementationClosureDigest(closure) !== closure.closureDigest) throw new TypeError(`catalog compiler closure digest mismatch ${binding.entrypointId}`);
    return Object.freeze({
      modulePath: binding.modulePath,
      exportName: binding.exportName,
      // A compiler closure is rooted at a module path, while the catalog
      // joins named exports.  Qualify the projected identity by export so a
      // single real Program closure can safely supply several declarations.
      entrypointId: `${closure.entrypointId}#${binding.exportName}`,
      closureDigest: closure.closureDigest as CatalogCompilerClosureFactV1["closureDigest"],
      programInputSetRoot: closure.programInputSetRoot as CatalogCompilerClosureFactV1["programInputSetRoot"],
    });
  });
  return sealCatalogCompilerClosureFacts(facts);
}

/**
 * Project the pre-commit capability-owner proposal from compiler-derived
 * boundary facts.  This proposal grants no runtime authority: the external
 * release issuer must later sign and exact-join its root.  Keeping projection
 * here prevents the catalog generator from minting owner refs from authoring
 * declarations or a raw capability index.
 */
export function projectCatalogProposedCapabilitySet(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  bindings: readonly CatalogCapabilityProposalBindingV1[],
): ReleaseQualifiedCapabilitySetV1 {
  const identities = new Set<string>();
  const refs: ReleaseQualifiedCapabilityRefV1[] = bindings.map((binding, index) => {
    if (binding === null || typeof binding !== "object") {
      throw new TypeError(`catalog capability binding ${index} must be an object`);
    }
    const identity = `${binding.capabilityId}\u0000${binding.version}`;
    if (identities.has(identity)) throw new TypeError(`duplicate catalog capability binding ${binding.capabilityId}`);
    identities.add(identity);
    const closure = findImplementationClosureById(receipt, binding.entrypointId);
    if (closure === null) throw new TypeError(`catalog capability closure missing ${binding.entrypointId}`);
    if (closure.entrypoint !== binding.modulePath) throw new TypeError(`catalog capability binding path mismatch ${binding.entrypointId}`);
    if (computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot) {
      throw new TypeError(`catalog capability input root mismatch ${binding.entrypointId}`);
    }
    if (recomputeImplementationClosureDigest(closure) !== closure.closureDigest) {
      throw new TypeError(`catalog capability closure digest mismatch ${binding.entrypointId}`);
    }
    return Object.freeze({
      capabilityId: binding.capabilityId,
      version: binding.version,
      schemaHash: binding.schemaHash,
      interpreterHash: binding.interpreterHash,
      ownerRef: hashDomain("aloha/boundary/catalog-capability-owner/v1", {
        capabilityId: binding.capabilityId,
        version: binding.version,
        schemaHash: binding.schemaHash,
        interpreterHash: binding.interpreterHash,
        modulePath: binding.modulePath,
        exportName: binding.exportName,
        entrypointId: closure.entrypointId,
        closureDigest: closure.closureDigest,
        programInputSetRoot: closure.programInputSetRoot,
      }) as ReleaseQualifiedCapabilityRefV1["ownerRef"],
    });
  });
  return sealReleaseQualifiedCapabilitySetV1(refs);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

function releaseBindingForRole(
  role: ReleaseClosureRoleV1,
  manifest: ReleaseRoleManifestV1,
  predicate?: ReleasePredicateBomEntryV1,
): ReleaseRoleBindingV1 & Partial<ReleasePredicateBomEntryV1> {
  if (role === "generic-core") return manifest.genericCore;
  if (role === "qualified-runner") return manifest.qualifiedRunner;
  if (role === "release-runtime") return manifest.releaseRuntime;
  if (predicate === undefined) throw new TypeError("predicate release binding missing");
  if (role === "predicate-adapter") return predicate;
  if (role === "material-provider") return {
    ...predicate,
    entrypointId: predicate.materialProviderEntrypointId,
    modulePath: predicate.materialProviderModulePath,
    exportName: predicate.materialProviderExportName,
  };
  return {
    entrypointId: predicate.oracleEntrypointId,
    modulePath: predicate.oracleModulePath,
    exportName: predicate.oracleExportName,
    predicateId: predicate.predicateId,
    predicateSpecDigest: predicate.predicateSpecDigest,
    predicateProgramDescriptorDigest: predicate.predicateProgramDescriptorDigest,
    oracleProgramDescriptorDigest: predicate.oracleProgramDescriptorDigest,
    adapterVersion: predicate.adapterVersion,
    oracleVersion: predicate.oracleVersion,
    compositionLeafDigest: predicate.compositionLeafDigest,
    predicateImplementationExportDigest: predicate.predicateImplementationExportDigest,
    oracleImplementationExportDigest: predicate.oracleImplementationExportDigest,
    commonEnvelopeRoleContractVersion: predicate.commonEnvelopeRoleContractVersion,
    materialProviderContractDigest: predicate.materialProviderContractDigest,
    materialProviderImplementationExportDigest: predicate.materialProviderImplementationExportDigest,
    materialProviderEntrypointId: predicate.materialProviderEntrypointId,
    materialProviderModulePath: predicate.materialProviderModulePath,
    materialProviderExportName: predicate.materialProviderExportName,
  };
}

function releaseClosureRoleRef(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  role: ReleaseClosureRoleV1,
  binding: ReleaseRoleBindingV1,
  diagnostics: BoundaryDiagnostic[],
): ReleaseClosureRefV1 | null {
  // The ID is only an index into compiler-derived facts.  The manifest's
  // module path and export are checked against the selected closure below;
  // filename heuristics are never a role admission rule.
  const closure = findImplementationClosureById(receipt, binding.entrypointId);
  if (closure === null) {
    diagnostics.push(diagnostic("invalid", "release-closure-entrypoint-missing", binding.entrypointId, `No compiler-derived implementation closure exists for ${role}`));
    return null;
  }
  if (closure.entrypoint !== binding.modulePath) {
    diagnostics.push(diagnostic("invalid", "release-role-entrypoint-binding", binding.entrypointId, `${role} manifest module path ${binding.modulePath} does not match compiler entrypoint ${closure.entrypoint}`));
  }
  if (computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot) {
    diagnostics.push(diagnostic("invalid", "release-closure-input-root-mismatch", binding.entrypointId, "Release role references a closure with a stale compiler input root"));
  }
  if (recomputeImplementationClosureDigest(closure) !== closure.closureDigest) {
    diagnostics.push(diagnostic("invalid", "release-closure-digest-mismatch", binding.entrypointId, "Release role references a closure whose compiler-visible digest does not recompute"));
  }
  const expectedKind = role === "release-runtime" ? "package-entrypoint" : "compiler-root";
  if (closure.kind !== expectedKind) {
    diagnostics.push(diagnostic("fail", "release-closure-role-kind", binding.entrypointId, `${role} must be an isolated ${expectedKind} closure`));
  }
  const predicateBinding = binding as Partial<ReleasePredicateBomEntryV1>;
  const exportDigest = role === "qualified-runner"
    ? (binding as ReleaseQualifiedRunnerBindingV1).implementationExportDigest
    : role === "predicate-adapter"
    ? predicateBinding.predicateImplementationExportDigest
    : role === "qualification-oracle"
      ? predicateBinding.oracleImplementationExportDigest
      : role === "material-provider"
        ? predicateBinding.materialProviderImplementationExportDigest
      : null;
  const moduleFile = closure.files.find((file) => file.path === binding.modulePath);
  const recomputedExportDigest = exportDigest === null || exportDigest === undefined || moduleFile === undefined
    ? null
    : computeImplementationExportDigest(binding.modulePath, binding.exportName, moduleFile.contentSha256);
  const requiresExportDigest = role === "qualified-runner" || role === "predicate-adapter" || role === "qualification-oracle" || role === "material-provider";
  if (requiresExportDigest && moduleFile === undefined) {
    diagnostics.push(diagnostic("invalid", "release-export-module-missing", binding.modulePath, `${role} module is absent from its own isolated compiler closure`));
  } else if (requiresExportDigest && (!isDigest(exportDigest) || recomputedExportDigest !== exportDigest)) {
    diagnostics.push(diagnostic("invalid", "release-export-digest-mismatch", binding.modulePath, `${role} named export identity does not match the exact tracked module bytes`));
  }
  return {
    role,
    entrypointId: closure.entrypointId,
    entrypoint: closure.entrypoint,
    modulePath: binding.modulePath,
    exportName: binding.exportName,
    predicateId: typeof predicateBinding.predicateId === "string" ? predicateBinding.predicateId : null,
    predicateSpecDigest: typeof predicateBinding.predicateSpecDigest === "string" ? predicateBinding.predicateSpecDigest : null,
    predicateProgramDescriptorDigest: typeof predicateBinding.predicateProgramDescriptorDigest === "string" ? predicateBinding.predicateProgramDescriptorDigest : null,
    oracleProgramDescriptorDigest: typeof predicateBinding.oracleProgramDescriptorDigest === "string" ? predicateBinding.oracleProgramDescriptorDigest : null,
    adapterVersion: typeof predicateBinding.adapterVersion === "string" ? predicateBinding.adapterVersion : null,
    oracleVersion: typeof predicateBinding.oracleVersion === "string" ? predicateBinding.oracleVersion : null,
    compositionLeafDigest: typeof predicateBinding.compositionLeafDigest === "string" ? predicateBinding.compositionLeafDigest : null,
    commonEnvelopeRoleContractVersion: typeof predicateBinding.commonEnvelopeRoleContractVersion === "string" ? predicateBinding.commonEnvelopeRoleContractVersion : null,
    materialProviderContractDigest: typeof predicateBinding.materialProviderContractDigest === "string" ? predicateBinding.materialProviderContractDigest : null,
    implementationExportDigest: recomputedExportDigest,
    closureDigest: closure.closureDigest,
    programInputSetRoot: closure.programInputSetRoot,
  };
}

function releaseClosurePaths(receipt: Pick<BoundaryReceipt, "implementationClosures">, ref: Pick<ReleaseClosureRefV1, "entrypointId">): ReadonlySet<string> {
  return new Set(findImplementationClosureById(receipt, ref.entrypointId)?.files.map((file) => file.path) ?? []);
}

/**
 * The release-runtime closure is the production implementation closure.  It
 * may contain compiler/test facts in the denominator, but it may never own a
 * test issuer, fixture, or test-only helper.  This is checked from the
 * compiler-derived closure itself, rather than inferred from import edges or
 * filename-selected role metadata.
 */
export function validateProductionReleaseClosure(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  releaseRuntime: Pick<ReleaseClosureRefV1, "entrypointId">,
  diagnostics: BoundaryDiagnostic[],
): void {
  const forbidden = [...releaseClosurePaths(receipt, releaseRuntime)]
    .filter(isTestOrFixturePath)
    .sort();
  for (const path of forbidden) {
    diagnostics.push(diagnostic("fail", "release-runtime-imports-test-fixture", releaseRuntime.entrypointId, `Production release-runtime closure contains test/fixture source ${path}`));
  }
}

/**
 * Apply the same exclusion to every compiler-derived application/runtime
 * closure.  The GateCore generated release runtime is not classified as an
 * application runtime, so it is checked separately by the release-role
 * derivation above; this covers apps/ and runtime/ entrypoints that could
 * otherwise bypass that role map.
 */
export function validateProductionRuntimeClosures(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): void {
  const productionEntrypoints = new Set(files.filter((file) => file.fileClass === "production-runtime").map((file) => file.path));
  for (const closure of receipt.implementationClosures) {
    if (!productionEntrypoints.has(closure.entrypoint) || isTestOrFixturePath(closure.entrypoint)) continue;
    validateProductionReleaseClosure(receipt, { entrypointId: closure.entrypointId }, diagnostics);
  }
}

function assertReleaseClosureExcludesEntrypoint(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  outer: ReleaseClosureRefV1,
  forbidden: ReleaseClosureRefV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  const outerPaths = releaseClosurePaths(receipt, outer);
  const forbiddenPaths = new Set([forbidden.entrypoint]);
  const overlap = [...forbiddenPaths].filter((path) => outerPaths.has(path)).sort();
  if (overlap.length > 0) {
    diagnostics.push(diagnostic("fail", "release-closure-role-import", outer.entrypointId, `${outer.role} compiler closure overlaps the ${forbidden.role} compiler closure at ${overlap.join(", ")}`));
  }
}

function isSharedReleasePort(path: string): boolean {
  return path.startsWith("specs/") ||
    path.startsWith("packages/canonical-codec/") ||
    path === "acceptance/gate-core/src/predicate-composition.ts" ||
    path === "acceptance/gate-core/src/predicate-contract.ts" ||
    // Six-step stage bytes are a frozen fact codec in the neutral spec layer,
    // not adapter or oracle semantics.
    path === "specs/evidence/src/six-step.ts";
}

function releaseOwnedClosurePaths(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  ref: ReleaseClosureRefV1,
): ReadonlySet<string> {
  return new Set([...releaseClosurePaths(receipt, ref)].filter((path) => !isSharedReleasePort(path)));
}

function assertReleaseOwnedClosuresDisjoint(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  left: ReleaseClosureRefV1,
  right: ReleaseClosureRefV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  const leftPaths = releaseOwnedClosurePaths(receipt, left);
  const overlap = [...releaseOwnedClosurePaths(receipt, right)].filter((path) => leftPaths.has(path)).sort();
  if (overlap.length > 0) {
    diagnostics.push(diagnostic("fail", "release-closure-role-overlap", left.entrypointId, `${left.role} and ${right.role} own overlapping compiler-closure source at ${overlap.join(", ")}`));
  }
}

function assertReleaseClosureContains(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  outer: ReleaseClosureRefV1,
  inner: ReleaseClosureRefV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  const outerPaths = releaseClosurePaths(receipt, outer);
  const missing = [...releaseClosurePaths(receipt, inner)].filter((path) => !outerPaths.has(path)).sort();
  if (missing.length > 0) diagnostics.push(diagnostic("fail", "release-closure-lineage-missing", outer.entrypointId, `${outer.role} compiler closure does not contain ${inner.role} source ${missing.join(", ")}`));
}

const QUALIFIED_RUNNER_OWNER_PATH = "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts";
const QUALIFIED_RUNNER_RUNTIME_ENTRY_PATH = "tools/runtime-release-packager/src/internal/qualified-release-runtime-entry.ts";
const QUALIFIED_RUNNER_RUNTIME_ENTRY_REFERENCE = "/// <reference path=\"./qualified-release-runtime-entry.ts\">";
const QUALIFIED_RUNNER_REQUIRED_CLOSURE_PATHS = Object.freeze([
  QUALIFIED_RUNNER_OWNER_PATH,
  QUALIFIED_RUNNER_RUNTIME_ENTRY_PATH,
  "tools/runtime-release-packager/src/internal/fresh-qualified-runner-host-owner.ts",
  "acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts",
  "acceptance/collectors/src/internal/predicate-material-source-owner.ts",
  RELEASE_RUNTIME_PATH,
]);

/**
 * The qualified runner is bundled from a separate, fresh-process entry. A
 * path string passed to the bundler is not compiler provenance, so the role
 * closure must contain the exact entry and its owner chain through a
 * runtime-inert triple-slash reference from the qualified runner owner.
 */
function validateQualifiedRunnerCompilerClosure(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  qualifiedRunner: ReleaseClosureRefV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  const closure = findImplementationClosureById(receipt, qualifiedRunner.entrypointId);
  if (closure === null) return;
  const paths = new Set(closure.files.map((file) => file.path));
  for (const path of QUALIFIED_RUNNER_REQUIRED_CLOSURE_PATHS) {
    if (!paths.has(path)) {
      diagnostics.push(diagnostic("invalid", "release-qualified-runner-closure-input-missing", path, "Qualified runner compiler closure is missing a required fresh-runner implementation input"));
    }
  }
  if (!closure.edges.some((edge) => edge.from === QUALIFIED_RUNNER_OWNER_PATH
    && edge.to === QUALIFIED_RUNNER_RUNTIME_ENTRY_PATH
    && edge.specifier === QUALIFIED_RUNNER_RUNTIME_ENTRY_REFERENCE)) {
    diagnostics.push(diagnostic("invalid", "release-qualified-runner-runtime-reference-missing", QUALIFIED_RUNNER_OWNER_PATH, "Qualified runner owner must bind the fresh runtime entry through the exact runtime-inert compiler reference"));
  }
}

export function computePredicateCompositionRootDigest(leaves: readonly string[]): string {
  return hashDomain("aloha/predicate-composition-root/v1", [...leaves].sort());
}

export function computeReleaseRoleManifestRootDigest(
  manifest: Omit<ReleaseRoleManifestV1, "rootDigest">,
): string {
  return hashDomain("aloha/boundary/release-role-manifest/v2", manifest);
}

function releaseClosureRootDigest(facts: Omit<ReleaseClosureFactsV1, "rootDigest">): string {
  return hashDomain("aloha/boundary/release-closures/v2", facts);
}

function manifestRoleRefs(manifest: ReleaseRoleManifestV1): ReleaseRoleBindingV1[] {
  return [
    manifest.genericCore,
    manifest.qualifiedRunner,
    ...manifest.predicateAdapters,
    ...manifest.predicateAdapters.map((entry) => ({
      entrypointId: entry.oracleEntrypointId,
      modulePath: entry.oracleModulePath,
      exportName: entry.oracleExportName,
    })),
    ...manifest.predicateAdapters.map((entry) => ({
      entrypointId: entry.materialProviderEntrypointId,
      modulePath: entry.materialProviderModulePath,
      exportName: entry.materialProviderExportName,
    })),
    manifest.releaseRuntime,
  ];
}

function validateReleaseRoleManifestShape(
  manifest: ReleaseRoleManifestV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  if (manifest.schemaVersion !== 1) diagnostics.push(diagnostic("invalid", "release-role-manifest-schema", "releaseRoleManifest.schemaVersion", "Unsupported generated release role manifest schema"));
  if (manifest.commonEnvelopeRoleContractVersion !== "1.0.0") diagnostics.push(diagnostic("invalid", "release-common-envelope-role-version", "releaseRoleManifest.commonEnvelopeRoleContractVersion", "Release manifest must bind the frozen CommonEnvelope role contract version"));
  const refs = manifestRoleRefs(manifest);
  const ids = refs.map((ref) => ref.entrypointId);
  const roleBindings = refs.map((ref) => `${ref.entrypointId}\0${ref.exportName}`);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(roleBindings).size !== roleBindings.length) {
    diagnostics.push(diagnostic("invalid", "release-role-entrypoint-unique", "releaseRoleManifest", "Release role entrypoint/export bindings must be non-empty and unique"));
  }
  const predicateIds = manifest.predicateAdapters.map((entry) => entry.predicateId);
  const leaves = manifest.predicateAdapters.map((entry) => entry.compositionLeafDigest);
  if (predicateIds.length === 0) diagnostics.push(diagnostic("invalid", "release-bom-predicate-empty", "releaseRoleManifest.predicateAdapters", "Release BOM must contain at least one predicate adapter"));
  if (new Set(predicateIds).size !== predicateIds.length) diagnostics.push(diagnostic("invalid", "release-bom-predicate-id-duplicate", "releaseRoleManifest.predicateAdapters", "Release BOM predicate IDs must be unique"));
  if (new Set(leaves).size !== leaves.length) diagnostics.push(diagnostic("invalid", "release-bom-predicate-leaf-duplicate", "releaseRoleManifest.predicateAdapters", "Release BOM composition leaves must be unique"));
  const sorted = [...manifest.predicateAdapters].sort((a, b) => a.predicateId.localeCompare(b.predicateId));
  if (canonical(sorted) !== canonical(manifest.predicateAdapters)) diagnostics.push(diagnostic("invalid", "release-bom-predicate-order", "releaseRoleManifest.predicateAdapters", "Release BOM predicate adapters must be sorted by predicate ID"));
  if (!isDigest(manifest.predicateCompositionRootDigest) || computePredicateCompositionRootDigest(leaves) !== manifest.predicateCompositionRootDigest) {
    diagnostics.push(diagnostic("invalid", "release-bom-root-mismatch", "releaseRoleManifest.predicateCompositionRootDigest", "Release BOM root must be the exact root of its unique predicate leaves"));
  }
  const { rootDigest: _rootDigest, ...withoutRoot } = manifest;
  if (!isDigest(manifest.rootDigest) || computeReleaseRoleManifestRootDigest(withoutRoot) !== manifest.rootDigest) {
    diagnostics.push(diagnostic("invalid", "release-role-manifest-root-mismatch", "releaseRoleManifest.rootDigest", "Generated release role manifest root does not recompute"));
  }
  for (const ref of refs) {
    if (typeof ref.modulePath !== "string" || ref.modulePath.length === 0 || typeof ref.exportName !== "string" || ref.exportName.length === 0) {
      diagnostics.push(diagnostic("invalid", "release-role-binding-shape", ref.entrypointId || "releaseRoleManifest", "Release role binding requires an exact module path and export name"));
    }
  }
  if (manifest.genericCore.modulePath !== RELEASE_GENERIC_CORE_PATH || manifest.genericCore.exportName !== "evaluateGateCoreRuntime") {
    diagnostics.push(diagnostic("fail", "release-generic-core-binding", "releaseRoleManifest.genericCore", "Generic core is pinned to acceptance/gate-core/src/index.ts#evaluateGateCoreRuntime"));
  }
  if (manifest.qualifiedRunner.modulePath !== "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts"
    || manifest.qualifiedRunner.exportName !== "observeQualifiedReleaseAcceptanceAdvisoryV1") {
    diagnostics.push(diagnostic("fail", "release-qualified-runner-binding", "releaseRoleManifest.qualifiedRunner", "Qualified runner is pinned to the packager-owned observer-only advisory export"));
  }
  if (!isDigest(manifest.qualifiedRunner.implementationExportDigest)) {
    diagnostics.push(diagnostic("invalid", "release-qualified-runner-export-digest", "releaseRoleManifest.qualifiedRunner.implementationExportDigest", "Qualified runner must bind its exact named export digest"));
  }
  if (manifest.releaseRuntime.modulePath !== RELEASE_RUNTIME_PATH || manifest.releaseRuntime.exportName !== "evaluateGateCore") {
    diagnostics.push(diagnostic("fail", "release-runtime-binding", "releaseRoleManifest.releaseRuntime", "Release runtime is pinned to acceptance/gate-core/src/generated/release-runtime.ts#evaluateGateCore"));
  }
  for (const entry of manifest.predicateAdapters) {
    if (!entry.modulePath.startsWith("acceptance/gate-core/src/predicates/") || !/\.(?:ts|tsx|js|jsx)$/.test(entry.modulePath)) {
      diagnostics.push(diagnostic("fail", "release-predicate-binding", entry.entrypointId, "Predicate adapter module must be a concrete GateCore predicates source"));
    }
    if (!isDigest(entry.predicateSpecDigest) || !isDigest(entry.predicateProgramDescriptorDigest) || !isDigest(entry.oracleProgramDescriptorDigest) || !isDigest(entry.compositionLeafDigest) || !isDigest(entry.predicateImplementationExportDigest) || !isDigest(entry.oracleImplementationExportDigest) || !isDigest(entry.materialProviderContractDigest) || !isDigest(entry.materialProviderImplementationExportDigest)) {
      diagnostics.push(diagnostic("invalid", "release-bom-digest-shape", entry.entrypointId, "Predicate BOM spec, program, oracle, material provider, composition leaf, and exact export digests must be canonical hashes"));
    }
    const { entrypointId: _entrypointId, oracleEntrypointId: _oracleEntrypointId, compositionLeafDigest: _compositionLeafDigest, ...leafInput } = entry;
    if (computePredicateCompositionLeafDigest(leafInput) !== entry.compositionLeafDigest) {
      diagnostics.push(diagnostic("invalid", "release-bom-leaf-mismatch", entry.entrypointId, "Predicate composition leaf must be independently derived from the exact release tuple and named export identities"));
    }
    if (typeof entry.adapterVersion !== "string" || entry.adapterVersion.length === 0 || typeof entry.oracleVersion !== "string" || entry.oracleVersion.length === 0) {
      diagnostics.push(diagnostic("invalid", "release-bom-version-shape", entry.entrypointId, "Predicate BOM adapter and oracle versions must be non-empty"));
    }
    if (typeof entry.oracleEntrypointId !== "string" || entry.oracleEntrypointId.length === 0 || typeof entry.oracleModulePath !== "string" || entry.oracleModulePath.length === 0 || typeof entry.oracleExportName !== "string" || entry.oracleExportName.length === 0) {
      diagnostics.push(diagnostic("invalid", "release-oracle-binding-shape", entry.entrypointId, "Each predicate BOM entry must bind its own qualification oracle entrypoint, module, and export"));
    } else if (!/\.(?:ts|tsx|js|jsx)$/.test(entry.oracleModulePath)) {
      diagnostics.push(diagnostic("fail", "release-oracle-binding", entry.oracleEntrypointId, "Qualification oracle module must be a concrete TS/JS source"));
    }
    if (entry.commonEnvelopeRoleContractVersion !== manifest.commonEnvelopeRoleContractVersion) {
      diagnostics.push(diagnostic("invalid", "release-common-envelope-role-version", entry.entrypointId, "Predicate material provider must bind the manifest CommonEnvelope role contract version"));
    }
    if (typeof entry.materialProviderEntrypointId !== "string" || entry.materialProviderEntrypointId.length === 0 || typeof entry.materialProviderModulePath !== "string" || entry.materialProviderModulePath.length === 0 || typeof entry.materialProviderExportName !== "string" || entry.materialProviderExportName.length === 0) {
      diagnostics.push(diagnostic("invalid", "release-material-provider-binding-shape", entry.entrypointId, "Each predicate BOM entry must bind its exact material provider entrypoint, module, and export"));
    } else if (!entry.materialProviderModulePath.startsWith("acceptance/collectors/src/material-providers/") || !/\.(?:ts|tsx|js|jsx)$/.test(entry.materialProviderModulePath)) {
      diagnostics.push(diagnostic("fail", "release-material-provider-binding", entry.materialProviderEntrypointId, "Material provider must be a concrete acceptance collector source"));
    }
  }
}

function validateManifestAgainstClosures(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  manifest: ReleaseRoleManifestV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  validateReleaseRoleManifestShape(manifest, diagnostics);
  for (const ref of manifestRoleRefs(manifest)) {
    const closure = findImplementationClosureById(receipt, ref.entrypointId);
    if (closure === null) {
      diagnostics.push(diagnostic("invalid", "release-role-entrypoint-missing", ref.entrypointId, `Generated release role entrypoint ${ref.modulePath} is not a compiler-derived closure`));
      continue;
    }
    if (closure.entrypoint !== ref.modulePath) diagnostics.push(diagnostic("invalid", "release-role-entrypoint-binding", ref.entrypointId, `Generated release role entrypoint ID does not bind ${ref.modulePath}`));
    const expectedKind = ref === manifest.releaseRuntime ? "package-entrypoint" : "compiler-root";
    if (closure.kind !== expectedKind) diagnostics.push(diagnostic("fail", "release-role-entrypoint-kind", ref.entrypointId, `Generated ${ref.modulePath} binding has closure kind ${closure.kind}, expected ${expectedKind}`));
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string, diagnostics: BoundaryDiagnostic[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) diagnostics.push(diagnostic("invalid", "release-manifest-keys", path, `Generated release metadata must contain exactly ${wanted.join(", ")}`));
}

function parseReleaseRoleBinding(value: unknown, path: string, diagnostics: BoundaryDiagnostic[], exact = true): ReleaseRoleBindingV1 | null {
  const record = asRecord(value);
  if (record === null || typeof record.entrypointId !== "string" || typeof record.modulePath !== "string" || typeof record.exportName !== "string") {
    diagnostics.push(diagnostic("invalid", "release-role-binding-shape", path, "Generated role binding must contain entrypointId, modulePath, and exportName strings"));
    return null;
  }
  if (exact) requireExactKeys(record, ["entrypointId", "modulePath", "exportName"], path, diagnostics);
  return { entrypointId: record.entrypointId, modulePath: posixPath(record.modulePath), exportName: record.exportName };
}

function parseReleaseRoleManifest(value: unknown, path: string, diagnostics: BoundaryDiagnostic[]): ReleaseRoleManifestV1 | null {
  const record = asRecord(value);
  if (record === null || record.schemaVersion !== 1) {
    diagnostics.push(diagnostic("invalid", "release-role-manifest-schema", path, "Generated release role manifest must have schemaVersion 1"));
    return null;
  }
  requireExactKeys(record, ["schemaVersion", "commonEnvelopeRoleContractVersion", "genericCore", "qualifiedRunner", "predicateAdapters", "releaseRuntime", "predicateCompositionRootDigest", "rootDigest"], path, diagnostics);
  const genericCore = parseReleaseRoleBinding(record.genericCore, `${path}.genericCore`, diagnostics);
  const qualifiedRunnerBinding = parseReleaseRoleBinding(record.qualifiedRunner, `${path}.qualifiedRunner`, diagnostics, false);
  const qualifiedRunnerRecord = asRecord(record.qualifiedRunner);
  let qualifiedRunner: ReleaseQualifiedRunnerBindingV1 | null = null;
  if (qualifiedRunnerBinding === null || qualifiedRunnerRecord === null || typeof qualifiedRunnerRecord.implementationExportDigest !== "string") {
    diagnostics.push(diagnostic("invalid", "release-qualified-runner-shape", `${path}.qualifiedRunner`, "Qualified runner requires entrypoint, module, export, and implementation export digest"));
  } else {
    requireExactKeys(qualifiedRunnerRecord, ["entrypointId", "modulePath", "exportName", "implementationExportDigest"], `${path}.qualifiedRunner`, diagnostics);
    qualifiedRunner = { ...qualifiedRunnerBinding, implementationExportDigest: qualifiedRunnerRecord.implementationExportDigest };
  }
  const releaseRuntime = parseReleaseRoleBinding(record.releaseRuntime, `${path}.releaseRuntime`, diagnostics);
  const rawPredicates = record.predicateAdapters;
  if (!Array.isArray(rawPredicates)) {
    diagnostics.push(diagnostic("invalid", "release-bom-predicate-type", `${path}.predicateAdapters`, "Generated predicate BOM must be an array"));
  }
  const predicateAdapters: ReleasePredicateBomEntryV1[] = [];
  for (const [index, raw] of (Array.isArray(rawPredicates) ? rawPredicates : []).entries()) {
    const binding = parseReleaseRoleBinding(raw, `${path}.predicateAdapters[${index}]`, diagnostics, false);
    const entry = asRecord(raw);
    if (binding === null || entry === null || typeof entry.predicateId !== "string" || typeof entry.predicateSpecDigest !== "string" || typeof entry.predicateProgramDescriptorDigest !== "string" || typeof entry.oracleProgramDescriptorDigest !== "string" || typeof entry.adapterVersion !== "string" || typeof entry.oracleVersion !== "string" || typeof entry.compositionLeafDigest !== "string" || typeof entry.predicateImplementationExportDigest !== "string" || typeof entry.oracleImplementationExportDigest !== "string" || typeof entry.oracleEntrypointId !== "string" || typeof entry.oracleModulePath !== "string" || typeof entry.oracleExportName !== "string" || typeof entry.commonEnvelopeRoleContractVersion !== "string" || typeof entry.materialProviderContractDigest !== "string" || typeof entry.materialProviderImplementationExportDigest !== "string" || typeof entry.materialProviderEntrypointId !== "string" || typeof entry.materialProviderModulePath !== "string" || typeof entry.materialProviderExportName !== "string") {
      diagnostics.push(diagnostic("invalid", "release-bom-predicate-shape", `${path}.predicateAdapters[${index}]`, "Predicate BOM entries require exact predicate, program, version, leaf, adapter, and oracle bindings"));
      continue;
    }
    requireExactKeys(entry, ["entrypointId", "modulePath", "exportName", "predicateId", "predicateSpecDigest", "predicateProgramDescriptorDigest", "oracleProgramDescriptorDigest", "adapterVersion", "oracleVersion", "compositionLeafDigest", "predicateImplementationExportDigest", "oracleImplementationExportDigest", "oracleEntrypointId", "oracleModulePath", "oracleExportName", "commonEnvelopeRoleContractVersion", "materialProviderContractDigest", "materialProviderImplementationExportDigest", "materialProviderEntrypointId", "materialProviderModulePath", "materialProviderExportName"], `${path}.predicateAdapters[${index}]`, diagnostics);
    predicateAdapters.push({
      ...binding,
      predicateId: entry.predicateId,
      predicateSpecDigest: entry.predicateSpecDigest,
      predicateProgramDescriptorDigest: entry.predicateProgramDescriptorDigest,
      oracleProgramDescriptorDigest: entry.oracleProgramDescriptorDigest,
      adapterVersion: entry.adapterVersion,
      oracleVersion: entry.oracleVersion,
      compositionLeafDigest: entry.compositionLeafDigest,
      predicateImplementationExportDigest: entry.predicateImplementationExportDigest,
      oracleImplementationExportDigest: entry.oracleImplementationExportDigest,
      oracleEntrypointId: entry.oracleEntrypointId,
      oracleModulePath: posixPath(entry.oracleModulePath),
      oracleExportName: entry.oracleExportName,
      commonEnvelopeRoleContractVersion: entry.commonEnvelopeRoleContractVersion,
      materialProviderContractDigest: entry.materialProviderContractDigest,
      materialProviderImplementationExportDigest: entry.materialProviderImplementationExportDigest,
      materialProviderEntrypointId: entry.materialProviderEntrypointId,
      materialProviderModulePath: posixPath(entry.materialProviderModulePath),
      materialProviderExportName: entry.materialProviderExportName,
    });
  }
  if (genericCore === null || qualifiedRunner === null || releaseRuntime === null || typeof record.commonEnvelopeRoleContractVersion !== "string" || typeof record.predicateCompositionRootDigest !== "string" || typeof record.rootDigest !== "string") return null;
  return {
    schemaVersion: 1,
    commonEnvelopeRoleContractVersion: record.commonEnvelopeRoleContractVersion,
    genericCore,
    qualifiedRunner,
    predicateAdapters,
    releaseRuntime,
    predicateCompositionRootDigest: record.predicateCompositionRootDigest,
    rootDigest: record.rootDigest,
  };
}

function readGeneratedReleaseRoleManifest(
  root: string,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): ReleaseRoleManifestV1 | null {
  const candidates = files.filter((file) => /(?:^|\/)(?:release-role|role)-manifest(?:\.generated)?\.(?:json|ts)$/.test(file.path));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    diagnostics.push(diagnostic("invalid", "release-role-manifest-ambiguous", candidates.map((file) => file.path).join(","), "Exactly one generated release role manifest is required"));
    return null;
  }
  const manifestFile = candidates[0]!;
  const manifestPath = manifestFile.path;
  if (manifestFile.fileClass !== "generated") {
    diagnostics.push(diagnostic("invalid", "release-role-manifest-not-generated", manifestPath, "Release role manifest must be a tracked generated output covered by the repository generation ledger"));
    return null;
  }
  if (manifestPath.endsWith(".json")) {
    const value = readJson(root, manifestPath, diagnostics);
    return value === null ? null : parseReleaseRoleManifest(value, manifestPath, diagnostics);
  }
  try {
    const source = readFileSync(abs(root, manifestPath), "utf8");
    const file = ts.createSourceFile(manifestPath, source, ts.ScriptTarget.Latest, true);
    const declaration = file.statements
      .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement) && Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)))
      .flatMap((statement) => statement.declarationList.declarations)
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "RELEASE_ROLE_MANIFEST" && ts.isVariableDeclarationList(candidate.parent) && (candidate.parent.flags & ts.NodeFlags.Const) !== 0);
    if (declaration?.initializer === undefined) {
      diagnostics.push(diagnostic("invalid", "release-role-manifest-export", manifestPath, "Generated TypeScript role manifest must export RELEASE_ROLE_MANIFEST"));
      return null;
    }
    const value = staticLiteralValue(declaration.initializer);
    return parseReleaseRoleManifest(value, manifestPath, diagnostics);
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "release-role-manifest-unreadable", manifestPath, String(error)));
    return null;
  }
}

function staticLiteralValue(expression: ts.Expression): unknown {
  let value = expression;
  while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value) || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
  if (ts.isCallExpression(value) && value.arguments.length === 1 && ts.isPropertyAccessExpression(value.expression) && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === "Object" && value.expression.name.text === "freeze") return staticLiteralValue(value.arguments[0]!);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(value)) return value.elements.map((element) => staticLiteralValue(element));
  if (ts.isObjectLiteralExpression(value)) {
    const result: Record<string, unknown> = {};
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (key !== null) result[key] = staticLiteralValue(property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        result[property.name.text] = undefined;
      }
    }
    return result;
  }
  return undefined;
}

function exportedNames(sourcePath: string, sourceText: string): Set<string> {
  const file = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) && statement.name) names.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) continue;
      if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
  }
  return names;
}

function unwrapStaticExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (
    ts.isAsExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) value = value.expression;
  return value;
}

/**
 * Read one property from a frozen static object without confusing
 * `Object.freeze`'s PropertyAccessExpression with an Identifier.  This is
 * intentionally AST-only: it never evaluates a candidate evaluator.
 */
function staticEvaluatorProperty(expression: ts.Expression, propertyName: string): ts.Expression | null {
  let value = unwrapStaticExpression(expression);
  if (ts.isCallExpression(value) && value.arguments.length === 1 &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) && value.expression.expression.text === "Object" &&
    value.expression.name.text === "freeze") {
    value = unwrapStaticExpression(value.arguments[0]!);
  }
  if (!ts.isObjectLiteralExpression(value)) return null;
  const property = value.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) && staticPropertyName(candidate.name) === propertyName);
  return property !== undefined && ts.isPropertyAssignment(property)
    ? unwrapStaticExpression(property.initializer)
    : null;
}

function staticPropertyName(name: ts.PropertyName | ts.PrivateIdentifier | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function sourceVariableDeclaration(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) return declaration;
    }
  }
  return null;
}

function exportedVariableDeclaration(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) return declaration;
    }
  }
  return null;
}

function staticArrayExpression(expression: ts.Expression): ts.ArrayLiteralExpression | null {
  let value = unwrapStaticExpression(expression);
  if (ts.isCallExpression(value) && value.arguments.length === 1 &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) && value.expression.expression.text === "Object" &&
    value.expression.name.text === "freeze") value = unwrapStaticExpression(value.arguments[0]!);
  return ts.isArrayLiteralExpression(value) ? value : null;
}

function exactGeneratedModuleSpecifier(fromPath: string, targetPath: string): string {
  const value = posixPath(relative(dirname(fromPath), targetPath));
  return value.startsWith(".") ? value : `./${value}`;
}

function localSourceImportTargets(root: string, fromPath: string, specifier: string): readonly string[] {
  if (!specifier.startsWith(".")) return [];
  const base = resolve(root, dirname(fromPath), specifier);
  const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  const explicitExtension = extname(specifier).toLowerCase();
  const extensionlessBase = [".js", ".jsx", ".mjs", ".cjs"].includes(explicitExtension)
    ? base.slice(0, -explicitExtension.length)
    : base;
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${extensionlessBase}${extension}`),
    ...sourceExtensions.map((extension) => `${extensionlessBase}/index${extension}`),
  ];
  return candidates.map((candidate) => posixPath(relative(root, candidate)));
}

function staticIdentifierProperty(object: ts.ObjectLiteralExpression, propertyName: string): string | null {
  const expression = staticEvaluatorProperty(object, propertyName);
  return expression !== null && ts.isIdentifier(expression) ? expression.text : null;
}

function staticStringProperty(object: ts.ObjectLiteralExpression, propertyName: string): string | null {
  const expression = staticEvaluatorProperty(object, propertyName);
  return expression !== null && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : null;
}

/**
 * The generated BOM is the only runtime resolver authority.  This check
 * proves the runtime evaluator object is the exact named export imported for
 * each manifest leaf; matching metadata alone is deliberately insufficient.
 */
function validateGeneratedPredicateCompositionSource(
  root: string,
  files: readonly TrackedFile[],
  manifest: ReleaseRoleManifestV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  const file = files.find((candidate) => candidate.path === RELEASE_PREDICATE_COMPOSITION_PATH);
  if (file === undefined || (file.language !== "typescript" && file.language !== "javascript")) {
    diagnostics.push(diagnostic("invalid", "release-bom-composition-source-missing", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated predicate composition source is required"));
    return;
  }
  let sourceText: string;
  try { sourceText = readFileSync(abs(root, file.path), "utf8"); } catch (error) {
    diagnostics.push(diagnostic("invalid", "release-bom-composition-source-unreadable", file.path, String(error)));
    return;
  }
  const sourceFile = ts.createSourceFile(file.path, sourceText, ts.ScriptTarget.Latest, true);
  const expectedAliases = manifest.predicateAdapters.map((_entry, index) => `predicateEvaluator${index}`);
  const expectedMaterialProviderAliases = manifest.predicateAdapters.map((_entry, index) => `materialProvider${index}`);
  const imports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier));
  for (const [index, entry] of manifest.predicateAdapters.entries()) {
    const expectedSpecifier = exactGeneratedModuleSpecifier(RELEASE_PREDICATE_COMPOSITION_PATH, entry.modulePath);
    const alias = expectedAliases[index]!;
    const matched = imports.some((statement) => {
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier) || specifier.text !== expectedSpecifier || statement.importClause?.isTypeOnly || statement.importClause?.namedBindings === undefined || !ts.isNamedImports(statement.importClause.namedBindings)) return false;
      return statement.importClause.namedBindings.elements.some((element) =>
        !element.isTypeOnly && element.name.text === alias && (element.propertyName?.text ?? element.name.text) === entry.exportName);
    });
    if (!matched) diagnostics.push(diagnostic("fail", "release-bom-generated-import-mismatch", RELEASE_PREDICATE_COMPOSITION_PATH, `Generated BOM must directly import ${entry.modulePath}#${entry.exportName} as ${alias}`));
    const expectedMaterialProviderSpecifier = exactGeneratedModuleSpecifier(RELEASE_PREDICATE_COMPOSITION_PATH, entry.materialProviderModulePath);
    const materialProviderAlias = expectedMaterialProviderAliases[index]!;
    const materialProviderMatched = imports.some((statement) => {
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier) || specifier.text !== expectedMaterialProviderSpecifier || statement.importClause?.isTypeOnly || statement.importClause?.namedBindings === undefined || !ts.isNamedImports(statement.importClause.namedBindings)) return false;
      return statement.importClause.namedBindings.elements.some((element) =>
        !element.isTypeOnly && element.name.text === materialProviderAlias && (element.propertyName?.text ?? element.name.text) === entry.materialProviderExportName);
    });
    if (!materialProviderMatched) diagnostics.push(diagnostic("fail", "release-bom-generated-material-provider-import-mismatch", RELEASE_PREDICATE_COMPOSITION_PATH, `Generated BOM must directly import ${entry.materialProviderModulePath}#${entry.materialProviderExportName} as ${materialProviderAlias}`));
  }
  const concreteImports = imports.flatMap((statement) => {
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) return [];
    const resolved = resolve(root, dirname(RELEASE_PREDICATE_COMPOSITION_PATH), specifier.text);
    const normalized = posixPath(relative(root, resolved));
    return normalized.startsWith("acceptance/gate-core/src/predicates/") ? [normalized] : [];
  });
  const expectedConcreteImports = [...new Set(manifest.predicateAdapters.map((entry) => entry.modulePath))].sort();
  if (canonical([...new Set(concreteImports)].sort()) !== canonical(expectedConcreteImports)) {
    diagnostics.push(diagnostic("fail", "release-bom-generated-concrete-import-set", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated BOM concrete adapter imports must exactly equal the manifest leaves"));
  }
  const concreteMaterialProviderImports = imports.flatMap((statement) => {
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) return [];
    const resolved = resolve(root, dirname(RELEASE_PREDICATE_COMPOSITION_PATH), specifier.text);
    const normalized = posixPath(relative(root, resolved));
    if (!normalized.startsWith("acceptance/collectors/src/material-providers/")) return [];
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly || clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) {
      return [{ modulePath: normalized, exportName: "<non-exact>", alias: "<non-exact>", typeOnly: clause?.isTypeOnly ?? false }];
    }
    return clause.namedBindings.elements.map((element) => ({
      modulePath: normalized,
      exportName: element.propertyName?.text ?? element.name.text,
      alias: element.name.text,
      typeOnly: element.isTypeOnly,
    }));
  });
  const expectedMaterialProviderImports = manifest.predicateAdapters.map((entry, index) => ({
    modulePath: entry.materialProviderModulePath,
    exportName: entry.materialProviderExportName,
    alias: expectedMaterialProviderAliases[index]!,
    typeOnly: false,
  }));
  const materialProviderImportKey = (value: (typeof concreteMaterialProviderImports)[number]): string =>
    `${value.modulePath}\u0000${value.exportName}\u0000${value.alias}\u0000${value.typeOnly}`;
  if (canonical([...concreteMaterialProviderImports].sort((left, right) => materialProviderImportKey(left).localeCompare(materialProviderImportKey(right)))) !==
    canonical([...expectedMaterialProviderImports].sort((left, right) => materialProviderImportKey(left).localeCompare(materialProviderImportKey(right))))) {
    diagnostics.push(diagnostic("fail", "release-bom-generated-material-provider-import-set", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated BOM material-provider imports must exactly equal the manifest export/alias bindings"));
  }
  const bindingsDeclaration = exportedVariableDeclaration(sourceFile, "RELEASE_PREDICATE_BINDINGS");
  const bindingsArray = bindingsDeclaration?.initializer === undefined ? null : staticArrayExpression(bindingsDeclaration.initializer);
  if (bindingsArray === null || bindingsArray.elements.length !== manifest.predicateAdapters.length) {
    diagnostics.push(diagnostic("fail", "release-bom-generated-bindings-shape", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated BOM must export one frozen literal binding per manifest leaf"));
  } else {
    for (const [index, element] of bindingsArray.elements.entries()) {
      const object = unwrapStaticExpression(element as ts.Expression);
      const frozenObject = ts.isCallExpression(object) && object.arguments.length === 1 && ts.isPropertyAccessExpression(object.expression) && ts.isIdentifier(object.expression.expression) && object.expression.expression.text === "Object" && object.expression.name.text === "freeze"
        ? unwrapStaticExpression(object.arguments[0]!)
        : object;
      const entry = manifest.predicateAdapters[index]!;
      const exactEvaluatorMetadata = ts.isObjectLiteralExpression(frozenObject) &&
        staticStringProperty(frozenObject, "predicateId") === entry.predicateId &&
        staticStringProperty(frozenObject, "predicateSpecDigest") === entry.predicateSpecDigest &&
        staticStringProperty(frozenObject, "predicateProgramDescriptorDigest") === entry.predicateProgramDescriptorDigest &&
        staticStringProperty(frozenObject, "oracleProgramDescriptorDigest") === entry.oracleProgramDescriptorDigest &&
        staticStringProperty(frozenObject, "adapterVersion") === entry.adapterVersion &&
        staticStringProperty(frozenObject, "oracleVersion") === entry.oracleVersion &&
        staticStringProperty(frozenObject, "compositionLeafDigest") === entry.compositionLeafDigest &&
        staticStringProperty(frozenObject, "predicateImplementationExportDigest") === entry.predicateImplementationExportDigest &&
        staticStringProperty(frozenObject, "oracleImplementationExportDigest") === entry.oracleImplementationExportDigest;
      const exactMaterialProviderMetadata = ts.isObjectLiteralExpression(frozenObject) &&
        staticStringProperty(frozenObject, "commonEnvelopeRoleContractVersion") === entry.commonEnvelopeRoleContractVersion &&
        staticStringProperty(frozenObject, "materialProviderContractDigest") === entry.materialProviderContractDigest &&
        staticStringProperty(frozenObject, "materialProviderImplementationExportDigest") === entry.materialProviderImplementationExportDigest;
      if (!exactEvaluatorMetadata || !ts.isObjectLiteralExpression(frozenObject) || staticIdentifierProperty(frozenObject, "evaluator") !== expectedAliases[index]) {
        diagnostics.push(diagnostic("fail", "release-bom-generated-evaluator-identity", RELEASE_PREDICATE_COMPOSITION_PATH, `Generated BOM binding ${index} must carry the exact imported evaluator identity`));
      }
      if (!exactMaterialProviderMetadata || !ts.isObjectLiteralExpression(frozenObject) || staticIdentifierProperty(frozenObject, "materialProvider") !== expectedMaterialProviderAliases[index]) {
        diagnostics.push(diagnostic("fail", "release-bom-generated-material-provider-identity", RELEASE_PREDICATE_COMPOSITION_PATH, `Generated BOM binding ${index} must carry the exact imported material-provider identity`));
      }
    }
  }
  const evaluatorMap = sourceVariableDeclaration(sourceFile, "PREDICATE_EVALUATORS");
  let mapValid = false;
  const mapInitializer = evaluatorMap?.initializer === undefined ? null : unwrapStaticExpression(evaluatorMap.initializer);
  if (mapInitializer !== null && ts.isNewExpression(mapInitializer) && ts.isIdentifier(mapInitializer.expression) && mapInitializer.expression.text === "Map" && mapInitializer.arguments?.length === 1) {
    const mapArgument = unwrapStaticExpression(mapInitializer.arguments[0]!);
    if (ts.isCallExpression(mapArgument) && ts.isPropertyAccessExpression(mapArgument.expression) && ts.isIdentifier(mapArgument.expression.expression) && mapArgument.expression.expression.text === "RELEASE_PREDICATE_BINDINGS" && mapArgument.expression.name.text === "map" && mapArgument.arguments.length === 1 && ts.isArrowFunction(mapArgument.arguments[0]!)) {
      const callback = mapArgument.arguments[0]!;
      const parameter = callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0]!.name) ? callback.parameters[0]!.name.text : null;
      const body = ts.isExpression(callback.body) ? unwrapStaticExpression(callback.body) : null;
      const tuple = body && ts.isArrayLiteralExpression(body) && body.elements.length === 2 ? body.elements : null;
      const keyExpression = tuple?.[0];
      const valueExpression = tuple?.[1];
      if (parameter !== null && tuple !== null && keyExpression !== undefined && valueExpression !== undefined && ts.isPropertyAccessExpression(keyExpression) && ts.isIdentifier(keyExpression.expression) && ts.isIdentifier(valueExpression)) {
        mapValid = keyExpression.expression.text === parameter && keyExpression.name.text === "predicateId" && valueExpression.text === parameter;
      }
    }
  }
  if (!mapValid) diagnostics.push(diagnostic("fail", "release-bom-generated-map-binding", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated resolver map must be derived only from RELEASE_PREDICATE_BINDINGS identities"));
  const resolver = sourceFile.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "resolvePredicateEvaluator" && Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)));
  const resolverReturn = resolver.length === 1 && resolver[0]!.body?.statements.length === 1 && ts.isReturnStatement(resolver[0]!.body.statements[0]) ? resolver[0]!.body.statements[0].expression : null;
  let resolverValid = false;
  if (resolverReturn !== null && resolverReturn !== undefined && ts.isBinaryExpression(resolverReturn) && resolverReturn.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && resolverReturn.right.kind === ts.SyntaxKind.NullKeyword) {
    const resolverCall = resolverReturn.left;
    if (ts.isCallExpression(resolverCall) && ts.isPropertyAccessExpression(resolverCall.expression)) {
      const mapAccess = resolverCall.expression;
      const mapObject = mapAccess.expression;
      const argument = resolverCall.arguments[0];
      const resolverParameter = resolver.length === 1 && resolver[0]!.parameters.length === 1 && ts.isIdentifier(resolver[0]!.parameters[0]!.name)
        ? resolver[0]!.parameters[0]!.name.text
        : null;
      resolverValid = ts.isIdentifier(mapObject) && mapObject.text === "PREDICATE_EVALUATORS" && mapAccess.name.text === "get" && resolverCall.arguments.length === 1 && resolverParameter === "predicateId" && ts.isIdentifier(argument) && argument.text === resolverParameter;
    }
  }
  if (!resolverValid) diagnostics.push(diagnostic("fail", "release-bom-generated-resolver-binding", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated resolver must return the exact BOM map value or null"));
  const rootDeclaration = exportedVariableDeclaration(sourceFile, "PREDICATE_COMPOSITION_ROOT_DIGEST");
  const rootValue = rootDeclaration?.initializer === undefined ? null : unwrapStaticExpression(rootDeclaration.initializer);
  if (rootValue === null || !ts.isStringLiteral(rootValue) || rootValue.text !== manifest.predicateCompositionRootDigest) diagnostics.push(diagnostic("invalid", "release-bom-generated-root-mismatch", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated BOM root must equal the manifest root"));
}

function hasExactNamedImport(sourceFile: ts.SourceFile, specifier: string, importedName: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) return false;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return false;
    return clause.namedBindings.elements.some((element) => !element.isTypeOnly && element.name.text === importedName && (element.propertyName?.text ?? element.name.text) === importedName);
  });
}

function validateReleaseWrapperSource(sourceText: string, diagnostics: BoundaryDiagnostic[]): void {
  const sourceFile = ts.createSourceFile(RELEASE_RUNTIME_PATH, sourceText, ts.ScriptTarget.Latest, true);
  if (!hasExactNamedImport(sourceFile, "../index.ts", "createReleaseAuthorityUnavailableResult")) {
    diagnostics.push(diagnostic("fail", "release-runtime-binding-import", RELEASE_RUNTIME_PATH, "Candidate wrapper must import the exact unavailable-result constructor"));
  }
  if (sourceText.includes("Date.now") || hasExactNamedImport(sourceFile, "../index.ts", "evaluateGateCoreRuntime")) {
    diagnostics.push(diagnostic("fail", "release-runtime-clock-binding", RELEASE_RUNTIME_PATH, "Candidate wrapper must not acquire time or execute GateCore; deployment runner owns both"));
  }

  const wrappers = sourceFile.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "evaluateGateCore" && Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)));
  const wrapper = wrappers.length === 1 ? wrappers[0]! : null;
  if (wrapper === null || wrapper.parameters.length !== 1 || !ts.isIdentifier(wrapper.parameters[0]!.name) || wrapper.body === undefined || wrapper.body.statements.length !== 1) {
    diagnostics.push(diagnostic("fail", "release-runtime-public-wrapper", RELEASE_RUNTIME_PATH, "Candidate runtime must expose one exact single-argument permanently unavailable wrapper"));
    return;
  }
  const finalReturn = wrapper.body.statements[0]!;
  const unavailableCall = ts.isReturnStatement(finalReturn) && finalReturn.expression !== undefined && ts.isCallExpression(finalReturn.expression)
    ? finalReturn.expression
    : null;
  const unavailableValid = unavailableCall !== null && ts.isIdentifier(unavailableCall.expression)
    && unavailableCall.expression.text === "createReleaseAuthorityUnavailableResult"
    && unavailableCall.arguments.length === 0;
  if (!unavailableValid) diagnostics.push(diagnostic("fail", "release-runtime-strict-call", RELEASE_RUNTIME_PATH, "Candidate wrapper must unconditionally return authority-unavailable without inspecting input"));
}

function validateReleaseAuthoritySource(sourceText: string, diagnostics: BoundaryDiagnostic[]): void {
  const sourceFile = ts.createSourceFile(RELEASE_AUTHORITY_PATH, sourceText, ts.ScriptTarget.Latest, true);
  const declarations = sourceFile.statements
    .filter((statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement) &&
      Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
    )
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "RELEASE_AUTHORITY");
  if (declarations.length !== 1 || declarations[0]!.initializer?.kind !== ts.SyntaxKind.NullKeyword) {
    diagnostics.push(diagnostic("invalid", "release-authority-not-null", RELEASE_AUTHORITY_PATH, "Generated release authority must remain the unique null placeholder until qualification is complete"));
  }
}

/**
 * Candidate repositories never mint executor authority.  The scheduler's
 * generated module is deliberately an exact null placeholder; a qualified
 * non-null issuer is supplied only by the external release composition.  Do
 * not validate this by executing the module or by trusting its type: both
 * would allow a hand-edited value to become a production authority.
 */
export function validateQualifiedExecutorAuthoritySource(sourceText: string, diagnostics: BoundaryDiagnostic[]): void {
  const sourceFile = ts.createSourceFile(SCHEDULER_AUTHORITY_PATH, sourceText, ts.ScriptTarget.Latest, true);
  const imports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement));
  const runtimeImports = imports.filter((statement) => statement.importClause === undefined || !statement.importClause.isTypeOnly);
  if (runtimeImports.length > 0) {
    diagnostics.push(diagnostic("fail", "qualified-executor-authority-runtime-import", SCHEDULER_AUTHORITY_PATH, "Generated scheduler authority placeholder may not execute a runtime or side-effect import"));
  }
  const typeImports = imports.filter((statement) => statement.importClause !== undefined && statement.importClause.isTypeOnly);
  const exactTypeImport = typeImports.length === 1 && (() => {
    const statement = typeImports[0]!;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "../index.ts") return false;
    const clause = statement.importClause;
    if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.length !== 1) return false;
    const element = clause.namedBindings.elements[0]!;
    return (clause.isTypeOnly || element.isTypeOnly) && element.name.text === "QualifiedExecutorAuthorityIssuer" && (element.propertyName?.text ?? element.name.text) === "QualifiedExecutorAuthorityIssuer";
  })();
  if (!exactTypeImport) {
    diagnostics.push(diagnostic("invalid", "qualified-executor-authority-import-shape", SCHEDULER_AUTHORITY_PATH, "Generated scheduler authority may contain at most the exact type-only QualifiedExecutorAuthorityIssuer import"));
  }
  const declarations = sourceFile.statements
    .filter((statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement) &&
      Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
    )
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "QUALIFIED_EXECUTOR_AUTHORITY");
  const declaration = declarations.length === 1 ? declarations[0]! : null;
  const typeText = declaration?.type?.getText(sourceFile).replace(/\s|_/g, "") ?? null;
  const exactDeclaration = declaration !== null &&
    declaration.type !== undefined &&
    typeText === "QualifiedExecutorAuthorityIssuer|null" &&
    declaration.initializer?.kind === ts.SyntaxKind.NullKeyword;
  if (!exactDeclaration) {
    diagnostics.push(diagnostic("invalid", "qualified-executor-authority-not-null", SCHEDULER_AUTHORITY_PATH, "Generated scheduler authority must remain the unique null placeholder until external qualification is injected"));
  }
  const declarationStatements = sourceFile.statements.filter((statement): statement is ts.VariableStatement =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some((candidate) => candidate === declaration),
  );
  const allowedStatements = new Set<ts.Statement>([...imports, ...declarationStatements]);
  if (declarationStatements.length !== 1 || declarationStatements[0]!.declarationList.declarations.length !== 1) {
    diagnostics.push(diagnostic("invalid", "qualified-executor-authority-extra-declaration", SCHEDULER_AUTHORITY_PATH, "Generated scheduler authority placeholder must contain exactly one exported const declaration"));
  }
  if (sourceFile.statements.some((statement) => !allowedStatements.has(statement))) {
    diagnostics.push(diagnostic("invalid", "qualified-executor-authority-extra-statement", SCHEDULER_AUTHORITY_PATH, "Generated scheduler authority placeholder may contain no runtime statements or additional exports"));
  }
}

/**
 * The Family execution composition is the third candidate-side authority
 * placeholder.  It must remain an exact type-only import plus `null`; a
 * generated non-null port would let a test or candidate package install an
 * executor without the private runtime-release join.
 */
export function validateFamilyExecutionCompositionSource(sourceText: string, diagnostics: BoundaryDiagnostic[]): void {
  const sourceFile = ts.createSourceFile(FAMILY_EXECUTION_COMPOSITION_PATH, sourceText, ts.ScriptTarget.Latest, true);
  const imports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement));
  const runtimeImports = imports.filter((statement) => statement.importClause === undefined || !statement.importClause.isTypeOnly);
  if (runtimeImports.length > 0) {
    diagnostics.push(diagnostic("fail", "family-execution-composition-runtime-import", FAMILY_EXECUTION_COMPOSITION_PATH, "Generated Family execution composition may not execute a runtime or side-effect import"));
  }
  const typeImports = imports.filter((statement) => statement.importClause !== undefined && statement.importClause.isTypeOnly);
  const exactTypeImport = typeImports.length === 1 && (() => {
    const statement = typeImports[0]!;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "../index.ts") return false;
    const clause = statement.importClause;
    if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.length !== 1) return false;
    const element = clause.namedBindings.elements[0]!;
    return (clause.isTypeOnly || element.isTypeOnly) && element.name.text === "FamilyFrozenProgramExecutionPort" && (element.propertyName?.text ?? element.name.text) === "FamilyFrozenProgramExecutionPort";
  })();
  if (!exactTypeImport) {
    diagnostics.push(diagnostic("invalid", "family-execution-composition-import-shape", FAMILY_EXECUTION_COMPOSITION_PATH, "Generated Family execution composition may contain at most the exact type-only FamilyFrozenProgramExecutionPort import"));
  }
  const declarations = sourceFile.statements
    .filter((statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement)
      && Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
    )
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "FAMILY_EXECUTION_PORT");
  const declaration = declarations.length === 1 ? declarations[0]! : null;
  const typeText = declaration?.type?.getText(sourceFile).replace(/\s|_/g, "") ?? null;
  const exactDeclaration = declaration !== null
    && declaration.type !== undefined
    && typeText === "FamilyFrozenProgramExecutionPort<unknown>|null"
    && declaration.initializer?.kind === ts.SyntaxKind.NullKeyword;
  if (!exactDeclaration) {
    diagnostics.push(diagnostic("invalid", "family-execution-composition-not-null", FAMILY_EXECUTION_COMPOSITION_PATH, "Generated Family execution composition must remain the unique null placeholder until private runtime qualification is injected"));
  }
  const declarationStatements = sourceFile.statements.filter((statement): statement is ts.VariableStatement =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some((candidate) => candidate === declaration),
  );
  const allowedStatements = new Set<ts.Statement>([...imports, ...declarationStatements]);
  if (declarationStatements.length !== 1 || declarationStatements[0]!.declarationList.declarations.length !== 1) {
    diagnostics.push(diagnostic("invalid", "family-execution-composition-extra-declaration", FAMILY_EXECUTION_COMPOSITION_PATH, "Generated Family execution composition must contain exactly one exported const declaration"));
  }
  if (sourceFile.statements.some((statement) => !allowedStatements.has(statement))) {
    diagnostics.push(diagnostic("invalid", "family-execution-composition-extra-statement", FAMILY_EXECUTION_COMPOSITION_PATH, "Generated Family execution composition may contain no runtime statements or additional exports"));
  }
}

const RUNTIME_RELEASE_BOOTSTRAP_PUBLIC_EXPORTS = new Set([
  "buildRuntimeReleaseComposition",
  "RuntimeReleaseCheckpointInputV1",
  "RuntimeReleaseSchedulerInputV1",
  "RuntimeReleaseRevmInputV1",
  "RuntimeReleaseReadyInputV1",
  "RuntimeReleaseCatalogInputV1",
  "RuntimeReleaseCatalogSnapshotV1",
  "RuntimeReleaseCatalogServiceV1",
  "RuntimeReleaseCompositionInputV1",
  "RuntimeReleaseCompositionServicesV1",
  "RuntimeReleaseFamilyRuntimeServiceV1",
]);

const PRIVATE_RUNTIME_RELEASE_NAMES = new Set([
  "authority",
  "capability",
  "issuer",
  "proof",
  "proofPort",
  "resolver",
  "signer",
  "rotate",
  "revoke",
  "privatePorts",
  "attestationComposition",
  "candidatePartitionProofIssuer",
  "schedulerIssuer",
  "readyBinding",
]);

/**
 * Keep the deployment bootstrap as the sole private join.  The public package
 * may expose the final composition constructor and its input/output types,
 * but neither private-port helpers nor a returned authority/issuer field may
 * escape.  This is deliberately source based: executing a forged bootstrap
 * would make the boundary depend on the very authority it is qualifying.
 */
export function validateRuntimeReleaseBootstrapSources(
  sources: ReadonlyMap<string, string>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const publicSource = sources.get(RUNTIME_RELEASE_PUBLIC_PATH);
  if (publicSource !== undefined) {
    const sourceFile = ts.createSourceFile(RUNTIME_RELEASE_PUBLIC_PATH, publicSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "./internal/bootstrap.ts") continue;
      if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) {
        diagnostics.push(diagnostic("fail", "runtime-release-public-bootstrap-leak", RUNTIME_RELEASE_PUBLIC_PATH, "Runtime release public API may not wildcard-re-export the private bootstrap"));
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const exported = element.name.text;
        const original = element.propertyName?.text ?? exported;
        if (original !== exported || !RUNTIME_RELEASE_BOOTSTRAP_PUBLIC_EXPORTS.has(exported)) {
          diagnostics.push(diagnostic("fail", "runtime-release-public-bootstrap-leak", RUNTIME_RELEASE_PUBLIC_PATH, `Private runtime-release bootstrap symbol ${original} is not a public export`, element.getStart(sourceFile)));
        }
      }
    }
  }

  const bootstrapSource = sources.get(RUNTIME_RELEASE_BOOTSTRAP_PATH);
  if (bootstrapSource === undefined) return;
  const sourceFile = ts.createSourceFile(RUNTIME_RELEASE_BOOTSTRAP_PATH, bootstrapSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const privateJoinNames = new Set(["composeRuntimeReleasePrivatePorts", "assertRuntimeReleasePrivatePortsCurrent"]);
  const allowedJoinOwners = new Set(["composeRuntimeReleasePrivatePorts", "buildRuntimeReleaseComposition"]);
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined || !privateJoinNames.has(statement.name.text)) continue;
    if (hasExportModifier(statement)) {
      diagnostics.push(diagnostic("fail", "runtime-release-bootstrap-private-join-export", RUNTIME_RELEASE_BOOTSTRAP_PATH, `Private runtime-release join ${statement.name.text} must not be exported`, statement.name.getStart(sourceFile)));
    }
  }

  const servicesInterface = sourceFile.statements.find((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "RuntimeReleaseCompositionServicesV1");
  if (servicesInterface !== undefined) {
    for (const member of servicesInterface.members) {
      if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      if (PRIVATE_RUNTIME_RELEASE_NAMES.has(member.name.text)) {
        diagnostics.push(diagnostic("fail", "runtime-release-bootstrap-leaks-private-port", RUNTIME_RELEASE_BOOTSTRAP_PATH, `Runtime release service surface leaks private authority/issuer field ${member.name.text}`, member.name.getStart(sourceFile)));
      }
    }
  }

  const buildFunction = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "buildRuntimeReleaseComposition");
  if (buildFunction === undefined) {
    diagnostics.push(diagnostic("invalid", "runtime-release-bootstrap-missing", RUNTIME_RELEASE_BOOTSTRAP_PATH, "Runtime release bootstrap must own one buildRuntimeReleaseComposition function"));
    return;
  }
  const buildReturnObjects: ts.ObjectLiteralExpression[] = [];
  const visitBuild = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "freeze") {
      const candidate = node.expression.arguments[0];
      if (candidate && ts.isObjectLiteralExpression(candidate)) buildReturnObjects.push(candidate);
    }
    ts.forEachChild(node, visitBuild);
  };
  visitBuild(buildFunction);
  for (const object of buildReturnObjects) {
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && PRIVATE_RUNTIME_RELEASE_NAMES.has(property.name.text)) {
        diagnostics.push(diagnostic("fail", "runtime-release-bootstrap-leaks-private-port", RUNTIME_RELEASE_BOOTSTRAP_PATH, `Runtime release bootstrap return leaks private authority/issuer field ${property.name.text}`, property.name.getStart(sourceFile)));
      }
      if (ts.isShorthandPropertyAssignment(property) && PRIVATE_RUNTIME_RELEASE_NAMES.has(property.name.text)) {
        diagnostics.push(diagnostic("fail", "runtime-release-bootstrap-leaks-private-port", RUNTIME_RELEASE_BOOTSTRAP_PATH, `Runtime release bootstrap return leaks private authority/issuer field ${property.name.text}`, property.name.getStart(sourceFile)));
      }
      if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression) && PRIVATE_RUNTIME_RELEASE_NAMES.has(property.expression.text)) {
        diagnostics.push(diagnostic("fail", "runtime-release-bootstrap-leaks-private-port", RUNTIME_RELEASE_BOOTSTRAP_PATH, `Runtime release bootstrap return spreads private authority/issuer value ${property.expression.text}`, property.expression.getStart(sourceFile)));
      }
    }
  }

  const functionFor = (node: ts.Node): ts.FunctionLikeDeclaration | null => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (
        ts.isFunctionDeclaration(current)
        || ts.isFunctionExpression(current)
        || ts.isArrowFunction(current)
        || ts.isMethodDeclaration(current)
        || ts.isGetAccessorDeclaration(current)
        || ts.isSetAccessorDeclaration(current)
        || ts.isConstructorDeclaration(current)
      ) return current;
      current = current.parent;
    }
    return null;
  };
  const visitJoins = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^issueRuntimeRelease/.test(node.expression.text)) {
      const owner = functionFor(node);
      const ownerName = owner && ts.isFunctionDeclaration(owner) ? owner.name?.text ?? null : null;
      if (ownerName === null || !allowedJoinOwners.has(ownerName)) {
        diagnostics.push(diagnostic("fail", "runtime-release-private-join-bypass", RUNTIME_RELEASE_BOOTSTRAP_PATH, `Runtime release owner ${node.expression.text} must be called only by the private release bootstrap join`, node.expression.getStart(sourceFile)));
      }
    }
    ts.forEachChild(node, visitJoins);
  };
  visitJoins(sourceFile);
}

const PRIVATE_DEPLOYMENT_STARTERS = Object.freeze({
  [SEARCHER_DEPLOYMENT_PATH]: "startLocalVerifiedDeploymentRuntimeBundleV1",
  [SEARCHER_RELEASE_RUNTIME_OWNER_PATH]: "startInstalledVerifiedDeploymentRuntimeBundleV1",
} as const);

const FORBIDDEN_SHARED_DEPLOYMENT_START_SYMBOLS = new Set([
  "startVerifiedDeploymentRuntimeBundleV1",
  "registerVerifiedDeploymentRuntimeStartV1",
  "consumeVerifiedDeploymentRuntimeStartV1",
]);

/**
 * The local loader and installed-package bootstrap each own their final
 * verified start join.  Keeping the two small joins private prevents a deep
 * import from turning raw manifest/bundle-shaped data into a production start
 * capability, while avoiding a shared registrar that would itself become a
 * second authority surface.
 */
export function validateSearcherRuntimeDeploymentStartupSources(
  sources: ReadonlyMap<string, string>,
  diagnostics: BoundaryDiagnostic[],
): void {
  if (sources.has("apps/searcher-runtime/src/internal/deployment-start-owner.ts")) {
    diagnostics.push(diagnostic(
      "fail",
      "deployment-shared-start-owner",
      "apps/searcher-runtime/src/internal/deployment-start-owner.ts",
      "A shared deployment start registrar/owner is forbidden; verified start joins must remain private to the local and installed-package owners",
    ));
  }

  for (const [ownerPath, starterName] of Object.entries(PRIVATE_DEPLOYMENT_STARTERS)) {
    const source = sources.get(ownerPath);
    if (source === undefined) {
      diagnostics.push(diagnostic("invalid", "deployment-private-starter-source-missing", ownerPath, `Required private deployment starter ${starterName} is missing`));
      continue;
    }
    const sourceFile = ts.createSourceFile(ownerPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = sourceFile.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === starterName);
    if (declarations.length !== 1) {
      diagnostics.push(diagnostic("invalid", "deployment-private-starter-missing", ownerPath, `Expected exactly one private ${starterName} declaration`));
    } else if (hasExportModifier(declarations[0]!)) {
      diagnostics.push(diagnostic("fail", "deployment-private-starter-export", ownerPath, `${starterName} must not be exported`, declarations[0]!.name!.getStart(sourceFile)));
    }
  }

  const privateNames = new Set<string>(Object.values(PRIVATE_DEPLOYMENT_STARTERS));
  for (const [path, source] of sources) {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const allowedPrivateName = PRIVATE_DEPLOYMENT_STARTERS[path as keyof typeof PRIVATE_DEPLOYMENT_STARTERS];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (FORBIDDEN_SHARED_DEPLOYMENT_START_SYMBOLS.has(node.text)) {
          diagnostics.push(diagnostic("fail", "deployment-shared-start-authority", path, `Shared deployment start authority symbol ${node.text} is forbidden`, node.getStart(sourceFile)));
        }
        if (privateNames.has(node.text) && node.text !== allowedPrivateName) {
          diagnostics.push(diagnostic("fail", "deployment-private-starter-leak", path, `Private deployment starter ${node.text} may appear only in its owning module`, node.getStart(sourceFile)));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

const ARTIFACT_LINEAGE_STAGE_ONE_RAW_ISSUER = "issueArtifactLineageStageOneCapabilityV1";

const ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_EXPORTS = Object.freeze([
  { name: "assertIssuedProductionArtifactLineageStageOneObserverPortV1", typeOnly: false },
  { name: "readArtifactLineageStageOneCapabilityV1", typeOnly: false },
  { name: "ArtifactLineageStageOneCapabilityV1", typeOnly: true },
  { name: "ArtifactLineageStageOneObservationV1", typeOnly: true },
  { name: "ProductionArtifactLineageStageOneObserverPortV1", typeOnly: true },
] as const);

const ARTIFACT_LINEAGE_STAGE_ONE_RELEASE_DENOMINATOR_PATHS = Object.freeze([
  "acceptance/gate-core/src/generated/predicate-composition.ts",
  "acceptance/gate-core/src/generated/release-role-manifest.ts",
  "acceptance/gate-core/src/generated/release-runtime.ts",
  "acceptance/gate-core/src/generated/release-authority.ts",
  "acceptance/gate-core/src/release-role-manifest.ledger.json",
] as const);

function exactNamedReExport(
  sourceFile: ts.SourceFile,
  moduleSpecifier: string,
  expected: readonly { readonly name: string; readonly typeOnly: boolean }[],
): boolean {
  const declarations = sourceFile.statements.filter((statement): statement is ts.ExportDeclaration =>
    ts.isExportDeclaration(statement)
    && statement.moduleSpecifier !== undefined
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === moduleSpecifier);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  if (declaration.isTypeOnly || declaration.exportClause === undefined || !ts.isNamedExports(declaration.exportClause)) {
    return false;
  }
  const actual = declaration.exportClause.elements.map(element => ({
    name: element.name.text,
    sourceName: element.propertyName?.text ?? element.name.text,
    typeOnly: element.isTypeOnly,
  })).sort((left, right) => `${left.typeOnly}:${left.name}`.localeCompare(`${right.typeOnly}:${right.name}`));
  const wanted = expected.map(element => ({
    name: element.name,
    sourceName: element.name,
    typeOnly: element.typeOnly,
  })).sort((left, right) => `${left.typeOnly}:${left.name}`.localeCompare(`${right.typeOnly}:${right.name}`));
  return canonical(actual) === canonical(wanted);
}

function hasOnlyNamedDeclarationExports(
  sourceFile: ts.SourceFile,
  expected: readonly string[],
): boolean {
  if (sourceFile.statements.some(statement =>
    ts.isExportAssignment(statement)
    || ts.isExportDeclaration(statement)
    || (hasExportModifier(statement)
      && ts.canHaveModifiers(statement)
      && (ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false)))) {
    return false;
  }
  return canonical([...exportedNames(sourceFile.fileName, sourceFile.text)].sort())
    === canonical([...expected].sort());
}

function validateFixedSearcherReleaseRuntimeOwnerV1(
  packageManifest: Record<string, unknown>,
  sources: ReadonlyMap<string, string>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const exportsValue = packageManifest.exports;
  const releaseRuntimeTarget = exportsValue !== null
    && typeof exportsValue === "object"
    && !Array.isArray(exportsValue)
    ? (exportsValue as Record<string, unknown>)[SEARCHER_RELEASE_RUNTIME_PACKAGE_SUBPATH]
    : undefined;
  if (packageManifest.name !== SEARCHER_RELEASE_RUNTIME_PACKAGE_NAME
    || releaseRuntimeTarget !== "./src/release-runtime.ts") {
    diagnostics.push(diagnostic(
      "fail",
      "searcher-release-runtime-package-owner",
      SEARCHER_RUNTIME_PACKAGE_MANIFEST_PATH,
      "The production runtime must be the fixed @aloha/searcher-runtime ./release-runtime package entrypoint",
    ));
  }
  const sourceText = sources.get(SEARCHER_RELEASE_RUNTIME_PATH);
  if (sourceText === undefined) {
    diagnostics.push(diagnostic(
      "invalid",
      "searcher-release-runtime-source-missing",
      SEARCHER_RELEASE_RUNTIME_PATH,
      "The fixed production runtime package entrypoint source is required",
    ));
    return;
  }
  const sourceFile = ts.createSourceFile(
    SEARCHER_RELEASE_RUNTIME_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (!hasOnlyNamedDeclarationExports(sourceFile, SEARCHER_RELEASE_RUNTIME_EXPORTS)) {
    diagnostics.push(diagnostic(
      "fail",
      "searcher-release-runtime-export-denominator",
      SEARCHER_RELEASE_RUNTIME_PATH,
      "The production runtime entrypoint must expose exactly its fixed two startup issuers and one branded session start",
    ));
  }
}

function validateFixedFinalPreReleasePackageOwnerV1(
  packageManifest: Record<string, unknown>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const target = publicPackageTargets(packageManifest).filter(entry =>
    entry.subpath === FINAL_PRE_RELEASE_PACKAGE_SUBPATH);
  if (packageManifest.name !== FINAL_PRE_RELEASE_PACKAGE_NAME
    || target.length !== 1
    || target[0]!.target !== "./src/final-pre-release-cli.ts") {
    diagnostics.push(diagnostic(
      "fail",
      "final-pre-release-package-owner",
      FINAL_PRE_RELEASE_PACKAGE_MANIFEST_PATH,
      "Final pre-release must be the unique fixed @aloha/runtime-release-packager aloha-final-pre-release bin entrypoint",
    ));
  }
}

const FINAL_PRE_RELEASE_CLI_EXACT_SOURCE_V1 = [
  'import { encodeCanonicalJson } from "../../../packages/canonical-codec/src/index.ts";',
  'import { runBoundaryGate } from "../../architecture-boundaries/src/index.ts";',
  'import { runFinalPreReleaseV1 } from "./final-pre-release-runner.ts";',
  'if (process.argv.length !== 2) throw new TypeError("final pre-release CLI accepts no arguments");',
  'const receipt = runBoundaryGate({ requirePushed: true });',
  'if (receipt.verdict !== "pass") throw new TypeError("final pre-release Boundary gate did not pass");',
  'const result = await runFinalPreReleaseV1(receipt);',
  'process.stdout.write(`${encodeCanonicalJson(result)}\\n`);',
].join("\n");

/** Exact same-process final composition. This intentionally rejects aliases,
 * clones/spreads, alternate loaders, try/catch fallbacks, extra calls, and a
 * second CLI seam rather than attempting to prove them equivalent. */
export function validateFinalPreReleaseCliSourceV1(
  sourceText: string,
  diagnostics: BoundaryDiagnostic[],
): void {
  const sourceFile = ts.createSourceFile(
    FINAL_PRE_RELEASE_CLI_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const expectedFile = ts.createSourceFile(
    FINAL_PRE_RELEASE_CLI_PATH,
    FINAL_PRE_RELEASE_CLI_EXACT_SOURCE_V1,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const expectedImports = [
    ["../../../packages/canonical-codec/src/index.ts", "encodeCanonicalJson"],
    ["../../architecture-boundaries/src/index.ts", "runBoundaryGate"],
    ["./final-pre-release-runner.ts", "runFinalPreReleaseV1"],
  ] as const;
  const imports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement));
  const importShapeMatches = imports.length === expectedImports.length
    && expectedImports.every(([specifier, name], index) => {
      const statement = imports[index];
      const clause = statement?.importClause;
      return statement !== undefined
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === specifier
        && clause !== undefined
        && !clause.isTypeOnly
        && clause.name === undefined
        && clause.namedBindings !== undefined
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length === 1
        && !clause.namedBindings.elements[0]!.isTypeOnly
        && clause.namedBindings.elements[0]!.propertyName === undefined
        && clause.namedBindings.elements[0]!.name.text === name;
    });
  if (!importShapeMatches) {
    diagnostics.push(diagnostic(
      "fail",
      "final-pre-release-cli-imports",
      FINAL_PRE_RELEASE_CLI_PATH,
      "Final pre-release CLI must import only its exact canonical encoder, Boundary gate, and final runner bindings",
    ));
  }
  if (compactStageOneSyntax(sourceFile) !== compactStageOneSyntax(expectedFile)) {
    diagnostics.push(diagnostic(
      "fail",
      "final-pre-release-cli-sequence",
      FINAL_PRE_RELEASE_CLI_PATH,
      "Final pre-release CLI must pass the identical process-issued pushed Boundary receipt directly to its sole final runner call",
    ));
  }
}

function fixedSearcherReleaseRuntimeClosureV1(
  implementationClosures: readonly ImplementationClosure[],
): ImplementationClosure | null {
  const matching = implementationClosures.filter(closure =>
    closure.entrypointId === packageEntrypointCompilerIdentityV1(
      SEARCHER_RELEASE_RUNTIME_PACKAGE_ENTRYPOINT_ID,
      SEARCHER_RELEASE_RUNTIME_TSCONFIG_PATH,
    )
    && closure.entrypoint === SEARCHER_RELEASE_RUNTIME_PATH
    && closure.kind === "package-entrypoint"
    && closure.packageName === SEARCHER_RELEASE_RUNTIME_PACKAGE_NAME
    && closure.packageManifestPath === SEARCHER_RUNTIME_PACKAGE_MANIFEST_PATH
    && closure.configPath === SEARCHER_RELEASE_RUNTIME_TSCONFIG_PATH);
  return matching.length === 1 ? matching[0]! : null;
}

function fixedPreReleaseRestartControllerClosureV1(
  implementationClosures: readonly ImplementationClosure[],
): ImplementationClosure | null {
  const entrypointId = packageEntrypointCompilerIdentityV1(
    PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_ENTRYPOINT_ID,
    PRE_RELEASE_RESTART_CONTROLLER_TSCONFIG_PATH,
  );
  const matching = implementationClosures.filter(closure =>
    closure.entrypointId === entrypointId
    && closure.entrypoint === PRE_RELEASE_RESTART_CONTROLLER_ENTRYPOINT_PATH
    && closure.kind === "package-entrypoint"
    && closure.packageName === PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_NAME
    && closure.packageManifestPath === PRE_RELEASE_RESTART_CONTROLLER_PACKAGE_MANIFEST_PATH
    && closure.configPath === PRE_RELEASE_RESTART_CONTROLLER_TSCONFIG_PATH);
  return matching.length === 1 ? matching[0]! : null;
}

interface ControllerMetafileObservationV1 {
  readonly sourceInputs: readonly Readonly<{ readonly path: string; readonly contentSha256: Hash; readonly byteLength: string }>[];
  readonly externalBuiltins: readonly string[];
  readonly metafileRoot: Hash;
  readonly internalEdges: readonly GraphEdge[];
}

function observePreReleaseControllerMetafileV1(repositoryRoot: string): ControllerMetafileObservationV1 {
  const outputPath = "pre-release-restart-controller.mjs";
  const entrypoint = PRE_RELEASE_RESTART_CONTROLLER_ENTRYPOINT_PATH;
  const result = buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: [entrypoint],
    outfile: outputPath,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    external: ["node:*"],
    legalComments: "none",
    charset: "utf8",
    treeShaking: true,
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.metafile === undefined) throw new TypeError("controller Boundary observer did not receive an esbuild metafile");
  const metafile: Metafile = result.metafile;
  const outputs = Object.entries(metafile.outputs);
  if (outputs.length !== 1 || outputs[0]![0] !== outputPath || outputs[0]![1].entryPoint !== entrypoint) {
    throw new TypeError("controller Boundary observer received an alternate esbuild output");
  }
  const sourceInputs = Object.keys(metafile.inputs).sort().map(path => {
    if (isAbsolute(path) || path.includes("\\") || path.includes("..")) {
      throw new TypeError(`controller Boundary metafile contains a non-canonical input: ${path}`);
    }
    const bytes = readFileSync(join(repositoryRoot, path));
    return Object.freeze({
      path,
      contentSha256: sha256Bytes(bytes) as Hash,
      byteLength: String(bytes.byteLength),
    });
  });
  const internalEdges = Object.entries(metafile.inputs).flatMap(([from, input]) =>
    input.imports.flatMap(item => item.external
      ? []
      : [{ from, to: posixPath(item.path), specifier: item.original ?? item.path }])).sort((left, right) =>
        `${left.from}\0${left.to}\0${left.specifier}`.localeCompare(`${right.from}\0${right.to}\0${right.specifier}`));
  const externalBuiltins = [...new Set(outputs[0]![1].imports.filter(item => item.external).map(item => item.path))].sort();
  const metafileProjection = Object.freeze({
    inputs: Object.entries(metafile.inputs).sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => ({ path, bytesInOutput: value.bytes })),
    output: {
      path: outputPath,
      entryPoint: outputs[0]![1].entryPoint,
      imports: outputs[0]![1].imports.map(item => ({ path: item.path, kind: item.kind, external: item.external })),
      exports: outputs[0]![1].exports,
    },
  });
  return Object.freeze({
    sourceInputs: Object.freeze(sourceInputs),
    externalBuiltins: Object.freeze(externalBuiltins),
    metafileRoot: hashDomain("aloha/pre-release-restart-controller-metafile/v1", metafileProjection) as Hash,
    internalEdges: Object.freeze(internalEdges),
  });
}

function runtimeModuleSpecifiersV1(path: string, sourceText: string): ReadonlySet<string> {
  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const runtime = clause === undefined || (!clause.isTypeOnly && (
        clause.name !== undefined
        || clause.namedBindings === undefined
        || ts.isNamespaceImport(clause.namedBindings)
        || clause.namedBindings.elements.some(element => !element.isTypeOnly)
      ));
      if (runtime) specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
      && !node.isTypeOnly
      && (node.exportClause === undefined
        || !ts.isNamedExports(node.exportClause)
        || node.exportClause.elements.some(element => !element.isTypeOnly))) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]!)) {
      specifiers.add(node.arguments[0]!.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined
      && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.add(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** Exact bidirectional comparison between compiler-resolved runtime edges and
 * esbuild's internal metafile imports for the controller source denominator. */
export function validatePreReleaseControllerCompilerMetafileEdgesV1(
  closure: Pick<ImplementationClosure, "edges">,
  sourcePaths: readonly string[],
  sources: ReadonlyMap<string, string>,
  metafileEdges: readonly GraphEdge[],
): void {
  const denominator = new Set(sourcePaths);
  if (denominator.size !== sourcePaths.length) throw new TypeError("controller source denominator contains a duplicate path");
  const runtimeSpecifiers = new Map(sourcePaths.map(path => {
    const source = sources.get(path);
    if (source === undefined) throw new TypeError(`controller source denominator is unreadable: ${path}`);
    return [path, runtimeModuleSpecifiersV1(path, source)] as const;
  }));
  const compilerEdges = closure.edges.filter(edge =>
    denominator.has(edge.from)
    && denominator.has(edge.to)
    && runtimeSpecifiers.get(edge.from)!.has(edge.specifier));
  const normalize = (edges: readonly GraphEdge[]) => edges.map(edge => ({
    from: edge.from,
    to: edge.to,
    specifier: edge.specifier,
  })).sort((left, right) => `${left.from}\0${left.to}\0${left.specifier}`.localeCompare(`${right.from}\0${right.to}\0${right.specifier}`));
  const compilerProjection = normalize(compilerEdges);
  const metafileProjection = normalize(metafileEdges);
  if (new Set(compilerProjection.map(edge => canonical(edge))).size !== compilerProjection.length
    || new Set(metafileProjection.map(edge => canonical(edge))).size !== metafileProjection.length
    || canonical(compilerProjection) !== canonical(metafileProjection)) {
    throw new TypeError("controller compiler closure and esbuild metafile internal imports do not exact-join");
  }
}

function closureContainsExactTrackedSourceV1(
  closure: ImplementationClosure,
  path: string,
): boolean {
  const files = closure.files.filter(file => file.path === path);
  const inputs = closure.programInputs.filter(input =>
    input.kind === "tracked" && input.logicalPath === `repo/${path}`);
  return files.length === 1
    && inputs.length === 1
    && inputs[0]!.blobSha === files[0]!.blobSha
    && inputs[0]!.contentSha256 === files[0]!.contentSha256
    && inputs[0]!.byteLength === files[0]!.byteLength;
}

function closureContainsExactEdgeV1(
  closure: ImplementationClosure,
  from: string,
  to: string,
  specifier: string,
): boolean {
  const matching = closure.edges.filter(edge => edge.from === from && edge.to === to);
  return matching.length === 1 && matching[0]!.specifier === specifier;
}

function fixedFinalPreReleaseCliClosureV1(
  implementationClosures: readonly ImplementationClosure[],
): ImplementationClosure | null {
  const entrypointId = packageEntrypointCompilerIdentityV1(
    FINAL_PRE_RELEASE_PACKAGE_ENTRYPOINT_ID,
    FINAL_PRE_RELEASE_TSCONFIG_PATH,
  );
  const matching = implementationClosures.filter(closure =>
    closure.entrypointId === entrypointId
    && closure.entrypoint === FINAL_PRE_RELEASE_CLI_PATH
    && closure.kind === "package-entrypoint"
    && closure.packageName === FINAL_PRE_RELEASE_PACKAGE_NAME
    && closure.packageManifestPath === FINAL_PRE_RELEASE_PACKAGE_MANIFEST_PATH
    && closure.configPath === FINAL_PRE_RELEASE_TSCONFIG_PATH
    && closureContainsExactTrackedSourceV1(closure, FINAL_PRE_RELEASE_CLI_PATH)
    && closureContainsExactTrackedSourceV1(closure, FINAL_PRE_RELEASE_RUNNER_PATH)
    && closureContainsExactTrackedSourceV1(closure, "tools/architecture-boundaries/src/index.ts")
    && closureContainsExactEdgeV1(
      closure,
      FINAL_PRE_RELEASE_CLI_PATH,
      "tools/architecture-boundaries/src/index.ts",
      "../../architecture-boundaries/src/index.ts",
    )
    && closureContainsExactEdgeV1(
      closure,
      FINAL_PRE_RELEASE_CLI_PATH,
      FINAL_PRE_RELEASE_RUNNER_PATH,
      "./final-pre-release-runner.ts",
    )
    && closureContainsExactEdgeV1(
      closure,
      FINAL_PRE_RELEASE_RUNNER_PATH,
      "tools/architecture-boundaries/src/index.ts",
      "../../architecture-boundaries/src/index.ts",
    ));
  return matching.length === 1 ? matching[0]! : null;
}

/** Read-only fixed controller query. The CLI package identity includes its
 * compiler config and cannot be selected by package name alone. */
export function queryFixedPreReleaseRestartControllerClosureV1(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
): ImplementationClosure | null {
  return fixedPreReleaseRestartControllerClosureV1(receipt.implementationClosures);
}

/** Read-only fixed final CLI query. Package/bin/config identity, the three
 * exact compiler edges, and their tracked source inputs must all agree. */
export function queryFixedFinalPreReleaseCliClosureV1(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
): ImplementationClosure | null {
  return fixedFinalPreReleaseCliClosureV1(receipt.implementationClosures);
}

/** Read-only fixed-owner query. It cannot issue a projection or controller
 * receipt; those require a process-issued pushed Boundary pass. */
export function queryFixedSearcherReleaseRuntimeClosureV1(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
): ImplementationClosure | null {
  return fixedSearcherReleaseRuntimeClosureV1(receipt.implementationClosures);
}

function countPrivateRegistryUses(
  sourceFile: ts.SourceFile,
  registryName: string,
  allowedCalls: ReadonlyMap<string, string | readonly string[]>,
): boolean {
  let references = 0;
  const calls = new Map<string, Map<string, number>>();
  let valid = true;
  const visit = (node: ts.Node, owner: string | null): void => {
    const nextOwner = ts.isFunctionDeclaration(node) && node.name !== undefined ? node.name.text : owner;
    if (ts.isIdentifier(node) && node.text === registryName) {
      references += 1;
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
        const call = node.parent.parent;
        const expectedOwnersValue = allowedCalls.get(node.parent.name.text);
        const expectedOwners = typeof expectedOwnersValue === "string" ? [expectedOwnersValue] : expectedOwnersValue;
        if (!ts.isCallExpression(call) || call.expression !== node.parent || expectedOwners === undefined || nextOwner === null || !expectedOwners.includes(nextOwner)) valid = false;
        else {
          const owners = calls.get(node.parent.name.text) ?? new Map<string, number>();
          owners.set(nextOwner, (owners.get(nextOwner) ?? 0) + 1);
          calls.set(node.parent.name.text, owners);
        }
      } else if (!ts.isVariableDeclaration(node.parent) || node.parent.name !== node) {
        valid = false;
      }
    }
    ts.forEachChild(node, child => visit(child, nextOwner));
  };
  visit(sourceFile, null);
  const expectedCallCount = [...allowedCalls.values()].reduce(
    (total, owners) => total + (typeof owners === "string" ? 1 : owners.length),
    0,
  );
  return valid
    && references === expectedCallCount + 1
    && [...allowedCalls].every(([method, ownersValue]) => {
      const owners = typeof ownersValue === "string" ? [ownersValue] : ownersValue;
      return owners.every(owner => calls.get(method)?.get(owner) === 1)
        && calls.get(method)?.size === owners.length;
    });
}

function compactStageOneSyntax(node: ts.Node): string {
  return node.getText().replace(/\s+/g, "").replace(/"/g, "'");
}

function namedFunctionSyntax(sourceFile: ts.SourceFile, name: string): string | null {
  const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  return declaration?.body === undefined ? null : compactStageOneSyntax(declaration.body);
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validateLocalOnlyArtifactLineageGitObserverV1(
  path: string,
  sourceFile: ts.SourceFile,
  diagnostics: BoundaryDiagnostic[],
): void {
  const runGit = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "runGit");
  const calls: ts.CallExpression[] = [];
  if (runGit?.body !== undefined) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "execFileSync") calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(runGit.body);
  }
  const call = calls.length === 1 ? calls[0]! : null;
  const argv = call?.arguments[1];
  const options = call?.arguments[2];
  const requiredArgv = [
    "--no-replace-objects",
    "core.excludesFile=/dev/null",
    "core.fsmonitor=false",
    "core.hooksPath=/dev/null",
    "credential.helper=",
    "core.sshCommand=/bin/false",
    "protocol.allow=never",
    "protocol.ext.allow=never",
    "protocol.file.allow=never",
  ] as const;
  const actualArgv = argv !== undefined && ts.isArrayLiteralExpression(argv)
    ? argv.elements.flatMap(element => {
      const value = ts.isSpreadElement(element) ? undefined : staticLiteralValue(element as ts.Expression);
      return typeof value === "string" ? [value] : [];
    })
    : [];
  const requiredEnvironment = Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_ASKPASS: "/bin/false",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    SSH_ASKPASS: "/bin/false",
  });
  let actualEnvironment: Record<string, unknown> | null = null;
  if (options !== undefined && ts.isObjectLiteralExpression(options)) {
    const envProperty = options.properties.find(property =>
      ts.isPropertyAssignment(property) && staticPropertyName(property.name) === "env");
    if (envProperty !== undefined
      && ts.isPropertyAssignment(envProperty)
      && ts.isObjectLiteralExpression(unwrapStaticExpression(envProperty.initializer))) {
      const envObject = unwrapStaticExpression(envProperty.initializer) as ts.ObjectLiteralExpression;
      if (envObject.properties.every(property => ts.isPropertyAssignment(property))) {
        actualEnvironment = Object.fromEntries(envObject.properties.map(property => {
          const assignment = property as ts.PropertyAssignment;
          return [staticPropertyName(assignment.name) ?? "<computed>", staticLiteralValue(assignment.initializer)];
        }));
      }
    }
  }
  const valid = call !== null
    && call.arguments.length === 3
    && staticLiteralValue(call.arguments[0]!) === "/usr/bin/git"
    && argv !== undefined
    && ts.isArrayLiteralExpression(argv)
    && !argv.elements.some(element => ts.isSpreadElement(element)
      && !ts.isIdentifier(element.expression))
    && requiredArgv.every(value => actualArgv.filter(candidate => candidate === value).length === 1)
    && actualArgv.filter(value => value.startsWith("core.sshCommand=")).every(value => value === "core.sshCommand=/bin/false")
    && actualArgv.filter(value => value.startsWith("protocol.allow=")).every(value => value === "protocol.allow=never")
    && actualArgv.filter(value => value.startsWith("protocol.ext.allow=")).every(value => value === "protocol.ext.allow=never")
    && actualArgv.filter(value => value.startsWith("protocol.file.allow=")).every(value => value === "protocol.file.allow=never")
    && actualEnvironment !== null
    && canonical(actualEnvironment) === canonical(requiredEnvironment);
  if (!valid) {
    diagnostics.push(diagnostic(
      "fail",
      "artifact-lineage-git-local-only",
      path,
      "Artifact-lineage Git observation must remain noninteractive and deny lazy fetch, protocols, SSH, credentials, and askpass",
    ));
  }
}

/** Stage 1 is a release-owned capability chain. The public facade is
 * read/assert/type-only; the internal owner is the sole issuer; the state
 * module owns both process-local registries; and the store module is the sole
 * durable sink constructor. Exact dependency edges are checked separately. */
export function validateArtifactLineageStageOneSources(
  sources: ReadonlyMap<string, string>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const requiredPaths = [
    ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_PATH,
    ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH,
    ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH,
    RELEASE_OWNED_OBSERVER_STORE_PATH,
    COLLECTOR_PUBLIC_BARREL_PATH,
  ] as const;
  const parsed = new Map<string, ts.SourceFile>();
  for (const path of requiredPaths) {
    const source = sources.get(path);
    if (source === undefined) {
      diagnostics.push(diagnostic("invalid", "artifact-lineage-stage-one-source-missing", path, "The release-owned Stage 1 source is required"));
      continue;
    }
    parsed.set(path, ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }

  const publicFile = parsed.get(ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_PATH);
  if (publicFile !== undefined && (publicFile.statements.length !== 1 || !exactNamedReExport(
    publicFile,
    "./internal/artifact-lineage-stage-one-state.ts",
    ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_EXPORTS,
  ))) {
    diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-public-surface", ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_PATH, "Stage 1 public surface must be the exact read/assert/type-only re-export"));
  }

  const barrelFile = parsed.get(COLLECTOR_PUBLIC_BARREL_PATH);
  if (barrelFile !== undefined) {
    if (!exactNamedReExport(barrelFile, "./production-artifact-lineage-observer.ts", ARTIFACT_LINEAGE_STAGE_ONE_PUBLIC_EXPORTS)) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-public-barrel", COLLECTOR_PUBLIC_BARREL_PATH, "Collector public barrel must expose only the exact Stage 1 read/assert/type surface"));
    }
    if (barrelFile.statements.some(statement =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.includes("artifact-lineage-stage-one-"))) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-internal-barrel", COLLECTOR_PUBLIC_BARREL_PATH, "Collector public barrel must not reach Stage 1 internal owner/state/store modules"));
    }
  }

  const ownerFile = parsed.get(ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH);
  if (ownerFile !== undefined) {
    validateLocalOnlyArtifactLineageGitObserverV1(
      ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH,
      ownerFile,
      diagnostics,
    );
    const issuer = ownerFile.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement)
      && statement.name?.text === "issueProductionArtifactLineageStageOneObserverPortV1"
      && hasExportModifier(statement));
    if (issuer.length !== 1 || !hasOnlyNamedDeclarationExports(ownerFile, ["issueProductionArtifactLineageStageOneObserverPortV1"])) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-owner-export", ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH, "Stage 1 owner must export exactly its one production observer-port issuer"));
    }
    const denominatorDeclaration = ownerFile.statements.flatMap(statement =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.filter(declaration =>
          ts.isIdentifier(declaration.name) && declaration.name.text === "RELEASE_DENOMINATOR_PATHS")
        : [])[0];
    let denominatorPaths: string[] | null = null;
    if (denominatorDeclaration?.initializer !== undefined) {
      let initializer = unwrapStaticExpression(denominatorDeclaration.initializer);
      if (ts.isCallExpression(initializer)
        && initializer.arguments.length === 1
        && ts.isPropertyAccessExpression(initializer.expression)
        && ts.isIdentifier(initializer.expression.expression)
        && initializer.expression.expression.text === "Object"
        && initializer.expression.name.text === "freeze") {
        initializer = unwrapStaticExpression(initializer.arguments[0]!);
      }
      if (ts.isArrayLiteralExpression(initializer)
        && initializer.elements.every(element => ts.isStringLiteral(unwrapStaticExpression(element as ts.Expression)))) {
        denominatorPaths = initializer.elements.map(element => (unwrapStaticExpression(element as ts.Expression) as ts.StringLiteral).text);
      }
    }
    if (denominatorPaths === null
      || canonical(denominatorPaths) !== canonical(ARTIFACT_LINEAGE_STAGE_ONE_RELEASE_DENOMINATOR_PATHS)) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-denominator", ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH, "Stage 1 exact-commit denominator must be the canonical five release artifacts in fixed order"));
    }
    const ownerInput = ownerFile.statements.find((statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "ProductionArtifactLineageStageOneOwnerInputV1");
    const ownerProperties = ownerInput?.members.flatMap(member =>
      ts.isPropertySignature(member) && member.name !== undefined && ts.isIdentifier(member.name)
        ? [[member.name.text, member] as const]
        : []) ?? [];
    const ownerPropertyMap = new Map(ownerProperties);
    const repositoryRootProperty = ownerPropertyMap.get("repositoryRoot");
    const storeProperty = ownerPropertyMap.get("store");
    const assertCurrentProperty = ownerPropertyMap.get("assertCurrent");
    const readonlyRequired = (property: ts.PropertySignature | undefined): boolean => property !== undefined
      && property.questionToken === undefined
      && (property.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false);
    const storeType = storeProperty?.type;
    const currentType = assertCurrentProperty?.type;
    if (ownerInput === undefined
      || hasExportModifier(ownerInput)
      || ownerInput.typeParameters !== undefined
      || ownerInput.heritageClauses !== undefined
      || canonical([...ownerPropertyMap.keys()].sort()) !== canonical(["assertCurrent", "repositoryRoot", "store"])
      || !readonlyRequired(repositoryRootProperty)
      || repositoryRootProperty?.type?.kind !== ts.SyntaxKind.StringKeyword
      || !readonlyRequired(storeProperty)
      || storeType === undefined
      || !ts.isTypeReferenceNode(storeType)
      || !ts.isIdentifier(storeType.typeName)
      || storeType.typeName.text !== "ReleaseOwnedObserverStoreCapabilityV1"
      || !readonlyRequired(assertCurrentProperty)
      || currentType === undefined
      || !ts.isFunctionTypeNode(currentType)
      || currentType.parameters.length !== 0
      || currentType.type.kind !== ts.SyntaxKind.VoidKeyword) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-caller-material", ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH, "Stage 1 owner input must be the exact readonly repositoryRoot/store/assertCurrent capability surface"));
    }
    const exactCommitReader = namedFunctionSyntax(ownerFile, "readExactCommitFile");
    const denominatorObserver = namedFunctionSyntax(ownerFile, "observeExactReleaseDenominator");
    if (exactCommitReader === null
      || !exactCommitReader.includes("['ls-tree','-z',candidateReleaseCommit,'--',path]")
      || !/bytes=awaitrunGit\(repositoryRoot,\['cat-file','blob',match\[2\]!?\],maxOutputBytes\)/.test(exactCommitReader)
      || denominatorObserver === null
      || !denominatorObserver.includes("for(constpathofRELEASE_DENOMINATOR_PATHS)")
      || !denominatorObserver.includes("awaitreadExactCommitFile(repositoryRoot,candidateReleaseCommit,path,maxOutputBytes)")
      || !denominatorObserver.includes("files.push(file)")
      || !denominatorObserver.includes("registerArtifactLineageStageOneCapabilityV1(store,assertCurrent,")) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-semantics", ARTIFACT_LINEAGE_STAGE_ONE_OWNER_PATH, "Stage 1 must iterate all five fixed paths and read their exact candidate-commit blobs before publication"));
    }
  }

  const stateFile = parsed.get(ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH);
  if (stateFile !== undefined) {
    const expectedStateExports = [
      "ArtifactLineageStageOneCapabilityV1",
      "ArtifactLineageStageOneObservationV1",
      "ProductionArtifactLineageStageOneObserverPortV1",
      "registerArtifactLineageStageOneCapabilityV1",
      "registerArtifactLineageStageOneObserverPortV1",
      "readArtifactLineageStageTwoAuthorityV1",
      "assertIssuedProductionArtifactLineageStageOneObserverPortV1",
      "assertArtifactLineageStageOneObserverStoreV1",
      "readArtifactLineageStageOneCapabilityV1",
    ];
    if (!hasOnlyNamedDeclarationExports(stateFile, expectedStateExports)) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-state-export", ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH, "Stage 1 state must expose only its fixed readers and two owner-only registrars"));
    }
    const observationsValid = countPrivateRegistryUses(stateFile, "observations", new Map([
      ["set", "registerArtifactLineageStageOneCapabilityV1"],
      ["get", "readArtifactLineageStageOneCapabilityV1"],
    ]));
    const portsValid = countPrivateRegistryUses(stateFile, "issuedPorts", new Map<string, string | readonly string[]>([
      ["set", "registerArtifactLineageStageOneObserverPortV1"],
      ["has", "assertIssuedProductionArtifactLineageStageOneObserverPortV1"],
      ["get", ["readArtifactLineageStageTwoAuthorityV1", "assertArtifactLineageStageOneObserverStoreV1"]],
    ]));
    if (!observationsValid || !portsValid) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-state-writer", ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH, "Stage 1 process-local registries may be written only once by their fixed registrar"));
    }
    const portRegistrar = namedFunctionSyntax(stateFile, "registerArtifactLineageStageOneObserverPortV1");
    const stageTwoAuthorityReader = namedFunctionSyntax(stateFile, "readArtifactLineageStageTwoAuthorityV1");
    const capabilityReader = namedFunctionSyntax(stateFile, "readArtifactLineageStageOneCapabilityV1");
    if (portRegistrar === null
      || !portRegistrar.includes("result??=observe()")
      || occurrences(portRegistrar, "assertCurrent()") < 2
      || stageTwoAuthorityReader === null
      || !stageTwoAuthorityReader.includes("assertArtifactLineageStageOneObserverStoreV1(port,store)")
      || !stageTwoAuthorityReader.includes("state.assertCurrent()")
      || !stageTwoAuthorityReader.includes("readReleaseOwnedObserverStoreV1(store).authority")
      || capabilityReader === null
      || occurrences(capabilityReader, "state.assertCurrent()") < 2
      || !capabilityReader.includes("for(constartifactofstate.observation.artifacts)")
      || !capabilityReader.includes("awaitsink.readContent(artifact.contentSha256)")) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-semantics", ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH, "Stage 1 cached ports and durable capability reads must recheck current authority and reread every stored object"));
    }
  }

  const storeFile = parsed.get(RELEASE_OWNED_OBSERVER_STORE_PATH);
  if (storeFile !== undefined) {
    if (!hasOnlyNamedDeclarationExports(storeFile, [
      "ReleaseOwnedObserverStoreCapabilityV1",
      "issueReleaseOwnedObserverStoreV1",
      "readReleaseOwnedObserverStoreV1",
    ])) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-store-export", RELEASE_OWNED_OBSERVER_STORE_PATH, "Release-owned observer store must expose only its opaque type, sole issuer and reader"));
    }
    if (!countPrivateRegistryUses(storeFile, "stores", new Map([
      ["set", "issueReleaseOwnedObserverStoreV1"],
      ["get", "readReleaseOwnedObserverStoreV1"],
    ]))) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-store-writer", RELEASE_OWNED_OBSERVER_STORE_PATH, "Release-owned observer stores may be registered only by their fixed issuer"));
    }
    const storeIssuer = namedFunctionSyntax(storeFile, "issueReleaseOwnedObserverStoreV1");
    if (storeIssuer === null
      || !storeIssuer.includes("storeIdentityHash:storeAuthorityRoot")
      || !storeIssuer.includes("directory:directoryValue")
      || !/observedStoreEpoch[,}]/.test(storeIssuer)) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-semantics", RELEASE_OWNED_OBSERVER_STORE_PATH, "Release-owned observer store identity must bind the release authority, physical directory and store epoch"));
    }
  }

  for (const [path, source] of sources) {
    const sourceFile = parsed.get(path) ?? ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === ARTIFACT_LINEAGE_STAGE_ONE_RAW_ISSUER) {
        diagnostics.push(diagnostic("fail", "artifact-lineage-stage-one-raw-issuer", path, "Artifact-lineage Stage 1 raw DTO capability issuer is forbidden", node.getStart(sourceFile)));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

const PRE_RELEASE_PUBLIC_TYPE_EXPORTS = Object.freeze([
  { name: "PreReleaseProcessImportReceiptV1", typeOnly: true },
  { name: "PreReleaseAdvisoryMaterialCapabilityV1", typeOnly: true },
  { name: "PreReleaseAdvisoryMaterialProjectionV1", typeOnly: true },
] as const);

function exactRequiredTypeReferenceParameter(
  declaration: ts.FunctionDeclaration | undefined,
  typeName: string,
): boolean {
  if (declaration === undefined || declaration.parameters.length !== 1) return false;
  const parameter = declaration.parameters[0]!;
  return ts.isIdentifier(parameter.name)
    && parameter.questionToken === undefined
    && parameter.dotDotDotToken === undefined
    && parameter.initializer === undefined
    && parameter.type !== undefined
    && ts.isTypeReferenceNode(parameter.type)
    && ts.isIdentifier(parameter.type.typeName)
    && parameter.type.typeName.text === typeName
    && parameter.type.typeArguments === undefined;
}

function topLevelFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  const declarations = sourceFile.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  return declarations.length === 1 ? declarations[0] : undefined;
}

function frozenStringArray(sourceFile: ts.SourceFile, name: string): readonly string[] | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || declaration.initializer === undefined) continue;
      const initializer = declaration.initializer;
      const array = ts.isCallExpression(initializer)
        && ts.isPropertyAccessExpression(initializer.expression)
        && ts.isIdentifier(initializer.expression.expression)
        && initializer.expression.expression.text === "Object"
        && initializer.expression.name.text === "freeze"
        && initializer.arguments.length === 1
        && ts.isArrayLiteralExpression(initializer.arguments[0]!)
        ? initializer.arguments[0]
        : ts.isArrayLiteralExpression(initializer) ? initializer : null;
      if (array === null || array.elements.some(element => !ts.isStringLiteralLike(element))) return null;
      return array.elements.map(element => (element as ts.StringLiteralLike).text);
    }
  }
  return null;
}

function validateLauncherPhaseSource(
  path: string,
  sourceText: string,
  phase: "pre-release" | "production",
  diagnostics: BoundaryDiagnostic[],
): void {
  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const main = topLevelFunction(sourceFile, "main");
  if (main?.body === undefined || main.parameters.length !== 0 || main.asteriskToken !== undefined
    || main.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true) {
    diagnostics.push(diagnostic("fail", "pre-release-launcher-phase-body", path, `${phase} launcher must own one zero-argument async main`));
    return;
  }
  const syntax = compactStageOneSyntax(main.body);
  let dynamicImports = 0;
  let hasComputedModuleCall = false;
  let hasTry = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImports += 1;
    if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "module") {
      hasComputedModuleCall = true;
    }
    if (ts.isTryStatement(node)) hasTry = true;
    ts.forEachChild(node, visit);
  };
  visit(main.body);

  const exactPhaseBody = phase === "pre-release"
    ? main.body.statements.length === 11
      && syntax.includes("constround=preverifyRound()")
      && syntax.includes("constauthorization=canonicalJson(round.authorizationSnapshot.bytes,'pre-releaseauthorization')")
      && syntax.includes("conststartupSnapshot=Object.freeze({snapshots:round.snapshots,authorizationSnapshot:round.authorizationSnapshot,})")
      && syntax.includes("construntime=round.snapshots['deployment-bundle.mjs']")
      && syntax.includes("Buffer.from(runtime.bytes).toString('base64')")
      && syntax.includes("runtime.sha256.slice(2)")
      && syntax.includes("constcapability=module.issuePreReleaseStartupCapabilityV1(startupSnapshot)")
      && syntax.includes("constsession=awaitmodule.startReleaseRuntimeSessionV1(capability)")
      && syntax.includes("awaitsession.done")
      && syntax.includes("awaitholdQualificationFinalUntilSignal(authorization)")
      && occurrences(syntax, "issuePreReleaseStartupCapabilityV1") === 1
      && occurrences(syntax, "startReleaseRuntimeSessionV1") === 1
      && occurrences(syntax, "holdQualificationFinalUntilSignal") === 1
      && occurrences(syntax, "issueInstalledProductionStartupCapabilityV1") === 0
      && sourceText.includes('const ROOT = "/var/lib/aloha/pre-release";')
      && !sourceText.includes("/etc/aloha")
      && canonical(frozenStringArray(sourceFile, "EXPORTS")) === canonical(SEARCHER_RELEASE_RUNTIME_EXPORTS)
    : main.body.statements.length === 8
      && syntax.includes("constsnapshot=preverifyInstalledRelease()")
      && syntax.includes("construntime=snapshot.artifacts['deployment-bundle.mjs']")
      && syntax.includes("Buffer.from(runtime.bytes).toString('base64')")
      && syntax.includes("runtime.sha256.slice(2)")
      && syntax.includes("constcapability=module.issueInstalledProductionStartupCapabilityV1(snapshot)")
      && syntax.includes("constservice=awaitmodule.startReleaseRuntimeSessionV1(capability)")
      && syntax.includes("awaitservice.done")
      && occurrences(syntax, "issueInstalledProductionStartupCapabilityV1") === 2
      && occurrences(syntax, "startReleaseRuntimeSessionV1") === 2
      && occurrences(syntax, "issuePreReleaseStartupCapabilityV1") === 1
      && sourceText.includes('const PACKAGE_MANIFEST = "/etc/aloha/release-package.json";')
      && sourceText.includes('const PACKAGE_APPROVAL = "/etc/aloha/trust/runtime-release-package-approval.json";')
      && sourceText.includes('const SIGNER_PIN = "/etc/aloha/trust/runtime-release-signer-pin.json";')
      && !sourceText.includes("/var/lib/aloha/pre-release");
  if (!exactPhaseBody || dynamicImports !== 1 || hasComputedModuleCall || hasTry || syntax.includes("regularSnapshot(")) {
    diagnostics.push(diagnostic(
      "fail",
      "pre-release-launcher-phase-body",
      path,
      `${phase} launcher must import the verified phase bundle once and invoke only its exact phase entry`,
      main.name?.getStart(sourceFile),
    ));
  }
}

/** Lock the two root-owned launchers and the pure three-export deployment
 * bundle to one snapshot and one module graph. Pre-release acceptance is a
 * separate owner bundle and never enters the searcher runtime closure. */
export function validatePreReleaseOwnerHostSources(
  sources: ReadonlyMap<string, string>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const required = [
    PRE_RELEASE_LAUNCHER_PATH,
    PRODUCTION_LAUNCHER_PATH,
    RUNTIME_BUNDLE_BUILDER_PATH,
    SEARCHER_RELEASE_RUNTIME_PATH,
    PRE_RELEASE_STAGING_OWNER_PATH,
    QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH,
    RUNTIME_RELEASE_PERFORMANCE_POLICY_OWNER_PATH,
  ] as const;
  const parsed = new Map<string, ts.SourceFile>();
  for (const path of required) {
    const source = sources.get(path);
    if (source === undefined) {
      diagnostics.push(diagnostic("invalid", "pre-release-owner-source-missing", path, "The exact pre-release owner source closure is required"));
      continue;
    }
    parsed.set(path, ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    ));
  }

  const preReleaseLauncher = sources.get(PRE_RELEASE_LAUNCHER_PATH);
  if (preReleaseLauncher !== undefined) validateLauncherPhaseSource(PRE_RELEASE_LAUNCHER_PATH, preReleaseLauncher, "pre-release", diagnostics);
  const productionLauncher = sources.get(PRODUCTION_LAUNCHER_PATH);
  if (productionLauncher !== undefined) validateLauncherPhaseSource(PRODUCTION_LAUNCHER_PATH, productionLauncher, "production", diagnostics);

  const builder = parsed.get(RUNTIME_BUNDLE_BUILDER_PATH);
  const bundleAssert = builder === undefined ? undefined : topLevelFunction(builder, "assertSelfContainedRuntimeBundleV1");
  if (bundleAssert?.body === undefined) {
    diagnostics.push(diagnostic("fail", "pre-release-runtime-export-surface", RUNTIME_BUNDLE_BUILDER_PATH, "The shared runtime bundle export scanner is required"));
  } else {
    const arrays: string[][] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node) && node.elements.some(element =>
        ts.isStringLiteralLike(element) && SEARCHER_RELEASE_RUNTIME_EXPORTS.includes(element.text as typeof SEARCHER_RELEASE_RUNTIME_EXPORTS[number]))) {
        if (node.elements.every(element => ts.isStringLiteralLike(element))) arrays.push(node.elements.map(element => (element as ts.StringLiteralLike).text));
      }
      ts.forEachChild(node, visit);
    };
    visit(bundleAssert.body);
    if (arrays.length !== 1 || canonical([...arrays[0]!].sort()) !== canonical([...SEARCHER_RELEASE_RUNTIME_EXPORTS].sort())) {
      diagnostics.push(diagnostic("fail", "pre-release-runtime-export-surface", RUNTIME_BUNDLE_BUILDER_PATH, "The shared runtime bundle must expose exactly the fixed three phase exports"));
    }
  }

  const releaseRuntime = parsed.get(SEARCHER_RELEASE_RUNTIME_PATH);
  if (releaseRuntime !== undefined
    && !hasOnlyNamedDeclarationExports(releaseRuntime, SEARCHER_RELEASE_RUNTIME_EXPORTS)) {
    diagnostics.push(diagnostic("fail", "pre-release-runtime-export-surface", SEARCHER_RELEASE_RUNTIME_PATH, "The deployment runtime entrypoint must expose only the fixed native runtime startup surface"));
  }

  const stagingOwner = parsed.get(PRE_RELEASE_STAGING_OWNER_PATH);
  if (stagingOwner !== undefined) {
    const forbiddenExports = new Set(["CompletePreReleaseRuntimeInputV1", "completePreReleaseRuntimeLaunchV1", "importPreReleaseRuntimeBundleV1"]);
    const leaked = [...exportedNames(PRE_RELEASE_STAGING_OWNER_PATH, stagingOwner.text)].filter(name => forbiddenExports.has(name));
    const launchInput = stagingOwner.statements.find((statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "IssuePreReleaseLaunchInputV1");
    const launchInputSyntax = launchInput === undefined ? "" : compactStageOneSyntax(launchInput);
    if (leaked.length !== 0 || launchInputSyntax.includes("qualifiedReleaseRunnerInputBytes")) {
      diagnostics.push(diagnostic("fail", "pre-release-owner-legacy-completion", PRE_RELEASE_STAGING_OWNER_PATH, "Legacy second-import, caller-observation completion and caller-authored runner input surfaces are forbidden"));
    }
  }

  const runnerState = parsed.get(QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH);
  if (runnerState !== undefined) {
    const expectedFunctions = [
      "installVerifiedQualifiedReleaseRunnerWireV1",
      "observeQualifiedReleaseAcceptanceAdvisoryV1",
      "readAuthorizedQualifiedReleaseRunnerWireV1",
      "readPublicQualifiedReleaseRunnerStateV1",
      "readQualifiedReleaseLineageObservationV1",
      "readVerifiedAuthorizedQualifiedRunnerWireLineageV1",
      "registerPublicQualifiedReleaseRunnerV1",
      "verifyAuthorizedQualifiedReleaseRunnerWireV1",
    ];
    const actualFunctions = runnerState.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name !== undefined).map(statement => statement.name!.text);
    if (canonical(actualFunctions.sort()) !== canonical(expectedFunctions.sort())) {
      diagnostics.push(diagnostic("fail", "pre-release-runner-state-export", QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH, "Neutral runner state must expose only its fixed registrar, readers, observer and signed-wire verifier"));
    }
  }
}

/** The pre-release handoff is receipt-only. This source check complements
 * exact import edges: it rejects a structural/raw prepare surface, a second
 * material reader, a Stage 2 denominator splice, and an observer-store path
 * reconstructed from an artifact locator. */
export function validatePreReleaseProductionBoundarySources(
  sources: ReadonlyMap<string, string>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const requiredPaths = [
    PRODUCTION_RELEASE_WORKFLOW_PATH,
    PRE_RELEASE_STAGING_PUBLIC_PATH,
    PRE_RELEASE_STAGING_OWNER_PATH,
    PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH,
    PRE_RELEASE_STAGING_SCHEMA_PATH,
    RELEASE_PACKAGER_PUBLIC_ROOT_PATH,
    RELEASE_DEPLOYMENT_PACKAGE_PATH,
    ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH,
    ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH,
    COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH,
  ] as const;
  const parsed = new Map<string, ts.SourceFile>();
  for (const path of requiredPaths) {
    const source = sources.get(path);
    if (source === undefined) {
      diagnostics.push(diagnostic("invalid", "pre-release-boundary-source-missing", path, "The receipt-only pre-release boundary source is required"));
      continue;
    }
    parsed.set(path, ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }

  const publicFile = parsed.get(PRE_RELEASE_STAGING_PUBLIC_PATH);
  if (publicFile !== undefined && (publicFile.statements.length !== 2
    || !exactNamedReExport(publicFile, "./pre-release-staging-contract.ts", PRE_RELEASE_PUBLIC_TYPE_EXPORTS)
    || !exactNamedReExport(publicFile, "./internal/pre-release-runtime-receipt-state.ts", [
      { name: "readPreReleaseAdvisoryMaterialCapabilityV1", typeOnly: false },
    ]))) {
    diagnostics.push(diagnostic("fail", "pre-release-receipt-public-surface", PRE_RELEASE_STAGING_PUBLIC_PATH, "Pre-release public surface must expose only the opaque receipt types and fixed projection reader"));
  }

  const schemaFile = parsed.get(PRE_RELEASE_STAGING_SCHEMA_PATH);
  if (schemaFile !== undefined) {
    const schemaSyntax = compactStageOneSyntax(schemaFile);
    if (!schemaSyntax.includes("runtimeOutputDirectory:'/var/lib/aloha/pre-release/runtime'")
      || !schemaSyntax.includes("checkpointDatabasePath:'/var/lib/aloha/pre-release/runtime/checkpoint.sqlite'")
      || !schemaSyntax.includes("processEvidenceDatabasePath:'/var/lib/aloha/pre-release/runtime/process-evidence.sqlite'")
      || !schemaSyntax.includes("observerStoreDirectory:'/var/lib/aloha-acceptance/pre-release/observer-store/content'")
      || schemaSyntax.includes("checkpointDatabasePath:'/var/lib/aloha/pre-release/checkpoint.sqlite'")
      || schemaSyntax.includes("processEvidenceDatabasePath:'/var/lib/aloha/pre-release/process-evidence.sqlite'")) {
      diagnostics.push(diagnostic("fail", "pre-release-fixed-runtime-paths", PRE_RELEASE_STAGING_SCHEMA_PATH, "Pre-release runtime SQLite and observer-store paths must remain the fixed hardened locations"));
    }
  }

  const stateFile = parsed.get(PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH);
  if (stateFile !== undefined) {
    if (!hasOnlyNamedDeclarationExports(stateFile, [
      "PreReleaseAdvisoryMaterialV1",
      "issuePreReleaseAdvisoryMaterialCapabilityV1",
      "readPreReleaseAdvisoryMaterialCapabilityV1",
      "readPreReleaseAdvisoryMaterialV1",
    ])) {
      diagnostics.push(diagnostic("fail", "pre-release-receipt-state-export", PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH, "Receipt state must expose one registrar, one public projection reader, and one workflow-only material reader"));
    }
    if (!countPrivateRegistryUses(stateFile, "receipts", new Map<string, string | readonly string[]>([
      ["set", "issuePreReleaseAdvisoryMaterialCapabilityV1"],
      ["get", ["readPreReleaseAdvisoryMaterialCapabilityV1", "readPreReleaseAdvisoryMaterialV1"]],
    ]))) {
      diagnostics.push(diagnostic("fail", "pre-release-receipt-state-owner", PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH, "Receipt state may be registered once and read only by its two fixed readers"));
    }
  }

  const workflowFile = parsed.get(PRODUCTION_RELEASE_WORKFLOW_PATH);
  if (workflowFile !== undefined) {
    const observe = workflowFile.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement)
      && statement.name?.text === "observeProductionReleaseAcceptanceAdvisoryV1"
      && hasExportModifier(statement));
    if (!exactRequiredTypeReferenceParameter(observe, "PreReleaseAdvisoryMaterialCapabilityV1")) {
      diagnostics.push(diagnostic("fail", "production-advisory-capability-only", PRODUCTION_RELEASE_WORKFLOW_PATH, "Production advisory observation must accept exactly one opaque PreReleaseAdvisoryMaterialCapabilityV1"));
    }
    const observeSyntax = observe?.body === undefined ? null : compactStageOneSyntax(observe.body);
    if (observeSyntax === null
      || !observeSyntax.includes("readPreReleaseAdvisoryMaterialV1(capability)")
      || !observeSyntax.includes("assertAdvisoryMaterialCurrent(capability,material)")
      || !observeSyntax.includes("observeQualifiedReleaseAcceptanceAdvisoryV1(material.qualifiedReleaseRunner,source)")) {
      diagnostics.push(diagnostic("fail", "production-advisory-observer-only", PRODUCTION_RELEASE_WORKFLOW_PATH, "Production advisory must reopen exact material, revalidate it, and invoke only the observer runner"));
    }
    const prepare = workflowFile.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement)
      && statement.name?.text === "prepareProductionReleaseAcceptanceSigningRequestV1"
      && hasExportModifier(statement));
    if (!exactRequiredTypeReferenceParameter(prepare, "PreReleaseAdvisoryMaterialCapabilityV1")) {
      diagnostics.push(diagnostic("fail", "production-release-preparation-capability-only", PRODUCTION_RELEASE_WORKFLOW_PATH, "Production release preparation must accept exactly one opaque PreReleaseAdvisoryMaterialCapabilityV1"));
    }
    const prepareSyntax = prepare?.body === undefined ? null : compactStageOneSyntax(prepare.body);
    if (prepareSyntax === null
      || !prepareSyntax.includes("readPreReleaseAdvisoryMaterialV1(capability)")
      || !prepareSyntax.includes("assertAdvisoryMaterialCurrent(capability,material)")
      || !prepareSyntax.includes("prepareQualifiedReleaseAcceptanceForExternalOwnerV1(material.qualifiedReleaseRunner,source)")
      || prepareSyntax.includes("advisoryJudgment")
      || prepareSyntax.includes("factLog")) {
      diagnostics.push(diagnostic("fail", "production-release-preparation-owner", PRODUCTION_RELEASE_WORKFLOW_PATH, "Production release preparation must revalidate frozen material and invoke only the qualified external-release runner"));
    }
  }

  const forbiddenAuthoring = [
    "PreparedReleaseAcceptance", "prepareReleasePackageV1", "publishApprovedReleasePackageV1",
    "ReleasePackagePublicationFence", "runtimeReleaseSigningRequestV1",
    "prepareRuntimeReleaseBindingPayloadV1", "verifySignedRuntimeReleaseBindingV1",
    "verifySignedRuntimeReleasePackageApprovalV1", "createRuntimeReleasePackageApprovalV1",
  ];
  for (const path of [PRODUCTION_RELEASE_WORKFLOW_PATH, RELEASE_PACKAGER_PUBLIC_ROOT_PATH, RELEASE_DEPLOYMENT_PACKAGE_PATH]) {
    const source = sources.get(path);
    if (source !== undefined && forbiddenAuthoring.some(name => source.includes(name))) {
      diagnostics.push(diagnostic("fail", "production-advisory-authoring-forbidden", path, "Advisory and public package verification surfaces must not expose acceptance/package/signing authoring"));
    }
  }

  const stageTwoFile = parsed.get(ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH);
  if (stageTwoFile !== undefined) {
    validateLocalOnlyArtifactLineageGitObserverV1(
      ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH,
      stageTwoFile,
      diagnostics,
    );
    if (!hasOnlyNamedDeclarationExports(stageTwoFile, ["observeArtifactLineageStageTwoGitEvidenceV1"])) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-two-owner-export", ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH, "Stage 2 Git owner must export only its exact observer"));
    }
    const pathsDeclaration = stageTwoFile.statements.flatMap(statement =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "PATHS")
        : [])[0];
    let stageTwoPaths: string[] | null = null;
    if (pathsDeclaration?.initializer !== undefined) {
      let initializer = unwrapStaticExpression(pathsDeclaration.initializer);
      if (ts.isCallExpression(initializer)
        && initializer.arguments.length === 1
        && ts.isPropertyAccessExpression(initializer.expression)
        && ts.isIdentifier(initializer.expression.expression)
        && initializer.expression.expression.text === "Object"
        && initializer.expression.name.text === "freeze") {
        initializer = unwrapStaticExpression(initializer.arguments[0]!);
      }
      if (ts.isArrayLiteralExpression(initializer)
        && initializer.elements.every(element => ts.isStringLiteral(unwrapStaticExpression(element as ts.Expression)))) {
        stageTwoPaths = initializer.elements.map(element => (unwrapStaticExpression(element as ts.Expression) as ts.StringLiteral).text);
      }
    }
    const observerSyntax = namedFunctionSyntax(stageTwoFile, "observeArtifactLineageStageTwoGitEvidenceV1");
    if (stageTwoPaths === null
      || canonical(stageTwoPaths) !== canonical(ARTIFACT_LINEAGE_STAGE_ONE_RELEASE_DENOMINATOR_PATHS)
      || observerSyntax === null
      || !observerSyntax.includes("for(letindex=0;index<5;index+=1)")
      || !observerSyntax.includes("constpath=PATHS[index]!")
      || !observerSyntax.includes("['ls-tree','-z',owner.candidateReleaseCommit,'--',path]")
      || !observerSyntax.includes("['cat-file','blob',item.blobObjectId]")) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-two-denominator", ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH, "Stage 2 Git must independently read the same fixed five-path exact-commit denominator"));
    }
  }

  const sourceFile = parsed.get(COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH);
  if (sourceFile !== undefined) {
    const issuerSyntax = namedFunctionSyntax(sourceFile, "issueProductionPredicateMaterialSourceV1");
    if (issuerSyntax === null
      || !issuerSyntax.includes("readArtifactLineageStageTwoAuthorityV1(artifactLineageStageOne,observerStore)")
      || !issuerSyntax.includes("observeArtifactLineageStageTwoGitEvidenceV1(authority,observed,sink.resolverPolicy.maxByteLength)")) {
      diagnostics.push(diagnostic("fail", "artifact-lineage-stage-two-authority-path", COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH, "Stage 2 Git authority must flow only from the fixed Stage 1/store reader into the sole Git owner"));
    }
  }
}

function validateReleaseRoleManifestSource(
  root: string,
  files: readonly TrackedFile[],
  manifest: ReleaseRoleManifestV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const sourceAt = (path: string): string | null => {
    const file = byPath.get(path);
    if (!file || (file.language !== "typescript" && file.language !== "javascript")) {
      diagnostics.push(diagnostic("invalid", "release-role-source-missing", path, "Release role module is not a tracked TS/JS source"));
      return null;
    }
    try { return readFileSync(abs(root, path), "utf8"); } catch (error) {
      diagnostics.push(diagnostic("invalid", "release-role-source-unreadable", path, String(error)));
      return null;
    }
  };
  const checkExport = (binding: ReleaseRoleBindingV1): void => {
    const source = sourceAt(binding.modulePath);
    if (source === null) return;
    if (!exportedNames(binding.modulePath, source).has(binding.exportName)) diagnostics.push(diagnostic("fail", "release-role-export-mismatch", binding.modulePath, `Generated role binding names non-exported symbol ${binding.exportName}`));
  };
  checkExport(manifest.genericCore);
  checkExport(manifest.releaseRuntime);
  if (manifest.releaseRuntime.modulePath === RELEASE_RUNTIME_PATH) {
    const runtimeSource = sourceAt(RELEASE_RUNTIME_PATH);
    if (runtimeSource !== null) validateReleaseWrapperSource(runtimeSource, diagnostics);
  }
  const authoritySource = sourceAt(RELEASE_AUTHORITY_PATH);
  if (authoritySource !== null) validateReleaseAuthoritySource(authoritySource, diagnostics);
  for (const entry of manifest.predicateAdapters) {
    const source = sourceAt(entry.modulePath);
    if (source === null) continue;
    if (!exportedNames(entry.modulePath, source).has(entry.exportName)) diagnostics.push(diagnostic("fail", "release-predicate-export-mismatch", entry.modulePath, `Generated predicate BOM names non-exported symbol ${entry.exportName}`));
    const predicateFile = byPath.get(entry.modulePath);
    if (predicateFile === undefined || computeImplementationExportDigest(entry.modulePath, entry.exportName, predicateFile.contentSha256) !== entry.predicateImplementationExportDigest) {
      diagnostics.push(diagnostic("invalid", "release-predicate-export-digest-mismatch", entry.modulePath, "Generated predicate export identity does not match the exact tracked module bytes"));
    }
    const oracleBinding: ReleaseRoleBindingV1 = {
      entrypointId: entry.oracleEntrypointId,
      modulePath: entry.oracleModulePath,
      exportName: entry.oracleExportName,
    };
    const oracleFile = byPath.get(entry.oracleModulePath);
    if (oracleFile?.fileClass !== "acceptance-pure-core" || entry.oracleModulePath.startsWith("acceptance/gate-core/")) {
      diagnostics.push(diagnostic("fail", "release-oracle-qualification-boundary", entry.oracleModulePath, "Qualification oracle must be an acceptance-only compiler root outside the live GateCore package"));
    }
    if (oracleFile === undefined || computeImplementationExportDigest(entry.oracleModulePath, entry.oracleExportName, oracleFile.contentSha256) !== entry.oracleImplementationExportDigest) {
      diagnostics.push(diagnostic("invalid", "release-oracle-export-digest-mismatch", entry.oracleModulePath, "Generated oracle export identity does not match the exact tracked module bytes"));
    }
    checkExport(oracleBinding);
  }
  const compositionSource = sourceAt(RELEASE_COMPOSITION_PATH);
  if (compositionSource !== null) {
    if (!exportedNames(RELEASE_COMPOSITION_PATH, compositionSource).has("RELEASE_ROLE_COMPOSITION")) {
      diagnostics.push(diagnostic("invalid", "release-composition-intent-missing", RELEASE_COMPOSITION_PATH, "Release generator requires one static RELEASE_ROLE_COMPOSITION authoring intent"));
    }
    const compositionFile = ts.createSourceFile(RELEASE_COMPOSITION_PATH, compositionSource, ts.ScriptTarget.Latest, true);
    for (const statement of compositionFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const targetPath = localSourceImportTargets(root, RELEASE_COMPOSITION_PATH, statement.moduleSpecifier.text)
        .find((candidate) => candidate.startsWith("acceptance/gate-core/src/predicates/"));
      if (targetPath !== undefined) diagnostics.push(diagnostic("fail", "release-composition-imports-concrete-adapter", RELEASE_COMPOSITION_PATH, `Static release intent must not import concrete predicate adapter ${targetPath}; generated BOM owns runtime imports`));
    }
  }
  validateGeneratedPredicateCompositionSource(root, files, manifest, diagnostics);
}

/** Validate generated role/BOM bindings against closures and source imports. */
export function validateReleaseRoleManifest(
  context: { readonly gitRoot: string; readonly files: readonly TrackedFile[]; readonly implementationClosures: readonly ImplementationClosure[] },
  manifest: ReleaseRoleManifestV1,
): readonly BoundaryDiagnostic[] {
  const diagnostics: BoundaryDiagnostic[] = [];
  validateManifestAgainstClosures({ implementationClosures: context.implementationClosures }, manifest, diagnostics);
  validateReleaseRoleManifestSource(context.gitRoot, context.files, manifest, diagnostics);
  return uniqueDiagnostics(diagnostics);
}

/** Resolve generated semantic release roles to exact compiler-visible closures. */
export function deriveReleaseClosureFacts(
  receipt: Pick<BoundaryReceipt, "implementationClosures">,
  manifest: ReleaseRoleManifestV1,
): ReleaseClosureDerivationV1 {
  const diagnostics: BoundaryDiagnostic[] = [];
  if (manifest === null || typeof manifest !== "object" || !("schemaVersion" in manifest) || manifest.schemaVersion !== 1) {
    // Runtime callers may still pass untyped data.  It is deliberately
    // rejected here rather than being treated as a caller-selected role map.
    diagnostics.push(diagnostic("invalid", "release-role-manifest-required", "releaseRoleManifest", "Release roles must come from a generated role manifest"));
    return { facts: null, diagnostics };
  }
  validateManifestAgainstClosures(receipt, manifest, diagnostics);
  const genericCore = releaseClosureRoleRef(receipt, "generic-core", releaseBindingForRole("generic-core", manifest), diagnostics);
  const qualifiedRunner = releaseClosureRoleRef(receipt, "qualified-runner", releaseBindingForRole("qualified-runner", manifest), diagnostics);
  const predicateAdapters = manifest.predicateAdapters
    .map((entry) => releaseClosureRoleRef(receipt, "predicate-adapter", releaseBindingForRole("predicate-adapter", manifest, entry), diagnostics))
    .filter((value): value is ReleaseClosureRefV1 => value !== null);
  const qualificationOracles = manifest.predicateAdapters
    .map((entry) => releaseClosureRoleRef(receipt, "qualification-oracle", releaseBindingForRole("qualification-oracle", manifest, entry), diagnostics))
    .filter((value): value is ReleaseClosureRefV1 => value !== null);
  const materialProviders = manifest.predicateAdapters
    .map((entry) => releaseClosureRoleRef(receipt, "material-provider", releaseBindingForRole("material-provider", manifest, entry), diagnostics))
    .filter((value): value is ReleaseClosureRefV1 => value !== null);
  const releaseRuntime = releaseClosureRoleRef(receipt, "release-runtime", releaseBindingForRole("release-runtime", manifest), diagnostics);
  if (genericCore === null || qualifiedRunner === null || releaseRuntime === null || predicateAdapters.length !== manifest.predicateAdapters.length || qualificationOracles.length !== manifest.predicateAdapters.length || materialProviders.length !== manifest.predicateAdapters.length || diagnostics.length > 0) {
    return { facts: null, diagnostics: uniqueDiagnostics(diagnostics) };
  }
  validateProductionReleaseClosure(receipt, releaseRuntime, diagnostics);
  validateProductionReleaseClosure(receipt, qualifiedRunner, diagnostics);
  validateQualifiedRunnerCompilerClosure(receipt, qualifiedRunner, diagnostics);
  for (const adapter of predicateAdapters) assertReleaseOwnedClosuresDisjoint(receipt, genericCore, adapter, diagnostics);
  for (let left = 0; left < predicateAdapters.length; left += 1) {
    for (let right = left + 1; right < predicateAdapters.length; right += 1) {
      assertReleaseOwnedClosuresDisjoint(receipt, predicateAdapters[left]!, predicateAdapters[right]!, diagnostics);
    }
  }
  for (let left = 0; left < qualificationOracles.length; left += 1) {
    for (let right = left + 1; right < qualificationOracles.length; right += 1) {
      assertReleaseOwnedClosuresDisjoint(receipt, qualificationOracles[left]!, qualificationOracles[right]!, diagnostics);
    }
  }
  for (const oracle of qualificationOracles) {
    assertReleaseOwnedClosuresDisjoint(receipt, genericCore, oracle, diagnostics);
    assertReleaseOwnedClosuresDisjoint(receipt, releaseRuntime, oracle, diagnostics);
    for (const adapter of predicateAdapters) assertReleaseOwnedClosuresDisjoint(receipt, adapter, oracle, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, genericCore, oracle, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, releaseRuntime, oracle, diagnostics);
    for (const adapter of predicateAdapters) assertReleaseClosureExcludesEntrypoint(receipt, adapter, oracle, diagnostics);
  }
  for (const provider of materialProviders) {
    assertReleaseOwnedClosuresDisjoint(receipt, genericCore, provider, diagnostics);
    for (const adapter of predicateAdapters) assertReleaseOwnedClosuresDisjoint(receipt, adapter, provider, diagnostics);
    for (const oracle of qualificationOracles) assertReleaseOwnedClosuresDisjoint(receipt, oracle, provider, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, genericCore, provider, diagnostics);
    for (const adapter of predicateAdapters) assertReleaseClosureExcludesEntrypoint(receipt, adapter, provider, diagnostics);
    for (const oracle of qualificationOracles) assertReleaseClosureExcludesEntrypoint(receipt, oracle, provider, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, provider, genericCore, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, provider, releaseRuntime, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, provider, qualifiedRunner, diagnostics);
  }
  for (const adapter of predicateAdapters) {
    assertReleaseClosureExcludesEntrypoint(receipt, genericCore, adapter, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, adapter, releaseRuntime, diagnostics);
  }
  for (const oracle of qualificationOracles) {
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, genericCore, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, releaseRuntime, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, qualifiedRunner, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, qualifiedRunner, oracle, diagnostics);
  }
  assertReleaseClosureContains(receipt, releaseRuntime, genericCore, diagnostics);
  for (const adapter of predicateAdapters) assertReleaseClosureContains(receipt, releaseRuntime, adapter, diagnostics);
  for (const provider of materialProviders) assertReleaseClosureContains(receipt, releaseRuntime, provider, diagnostics);
  assertReleaseClosureContains(receipt, qualifiedRunner, releaseRuntime, diagnostics);
  if (diagnostics.length > 0) return { facts: null, diagnostics: uniqueDiagnostics(diagnostics) };
  const base = Object.freeze({
    schemaVersion: 1 as const,
    genericCore,
    qualifiedRunner,
    predicateAdapters: Object.freeze(predicateAdapters),
    qualificationOracles: Object.freeze(qualificationOracles),
    materialProviders: Object.freeze(materialProviders),
    releaseRuntime,
    predicateCompositionRootDigest: manifest.predicateCompositionRootDigest,
    commonEnvelopeRoleContractVersion: manifest.commonEnvelopeRoleContractVersion,
    roleManifestRootDigest: manifest.rootDigest,
  });
  return {
    facts: Object.freeze({ ...base, rootDigest: releaseClosureRootDigest(base) }),
    diagnostics: [],
  };
}

/** Revalidate a stored role map against the current compiler-derived receipt. */
export function validateReleaseClosureFacts(
  receipt: Pick<BoundaryReceipt, "implementationClosures" | "releaseRoleManifest">,
  facts: ReleaseClosureFactsV1,
): readonly BoundaryDiagnostic[] {
  const diagnostics: BoundaryDiagnostic[] = [];
  const currentManifest = receipt.releaseRoleManifest;
  if (currentManifest === null) {
    diagnostics.push(diagnostic("invalid", "release-role-manifest-required", "releaseClosures.roleManifestRootDigest", "Stored release closure facts require the current generated role manifest"));
    return diagnostics;
  }
  validateReleaseRoleManifestShape(currentManifest, diagnostics);
  if (facts.roleManifestRootDigest !== currentManifest.rootDigest) {
    diagnostics.push(diagnostic("invalid", "release-closure-manifest-mismatch", "releaseClosures.roleManifestRootDigest", "Stored release closure facts are not bound to the current generated role manifest"));
  }
  if (facts.predicateCompositionRootDigest !== undefined && !isDigest(facts.predicateCompositionRootDigest)) diagnostics.push(diagnostic("invalid", "release-bom-root-mismatch", "releaseClosures.predicateCompositionRootDigest", "Release closure facts contain an invalid BOM root"));
  if (facts.commonEnvelopeRoleContractVersion !== currentManifest.commonEnvelopeRoleContractVersion) diagnostics.push(diagnostic("invalid", "release-common-envelope-role-version", "releaseClosures.commonEnvelopeRoleContractVersion", "Stored release closure facts do not bind the current CommonEnvelope role contract"));
  if (facts.schemaVersion !== 1) diagnostics.push(diagnostic("invalid", "release-closure-schema", "releaseClosures.schemaVersion", "Unsupported release closure facts schema"));
  const refs = [facts.genericCore, facts.qualifiedRunner, ...facts.predicateAdapters, ...facts.qualificationOracles, ...facts.materialProviders, facts.releaseRuntime];
  if (new Set(refs.map((ref) => `${ref.entrypointId}\0${ref.exportName}`)).size !== refs.length) diagnostics.push(diagnostic("invalid", "release-closure-role-alias", "releaseClosures", "Stored release roles alias one compiler closure export"));
  const predicateBindingKey = (ref: ReleaseClosureRefV1): string => canonical({
    predicateId: ref.predicateId,
    predicateSpecDigest: ref.predicateSpecDigest,
    predicateProgramDescriptorDigest: ref.predicateProgramDescriptorDigest,
    oracleProgramDescriptorDigest: ref.oracleProgramDescriptorDigest,
    adapterVersion: ref.adapterVersion,
    oracleVersion: ref.oracleVersion,
    compositionLeafDigest: ref.compositionLeafDigest,
    commonEnvelopeRoleContractVersion: ref.commonEnvelopeRoleContractVersion,
    materialProviderContractDigest: ref.materialProviderContractDigest,
  });
  if (facts.predicateAdapters.length !== facts.qualificationOracles.length || facts.predicateAdapters.length !== facts.materialProviders.length || facts.predicateAdapters.some((adapter, index) => predicateBindingKey(adapter) !== predicateBindingKey(facts.qualificationOracles[index]!) || predicateBindingKey(adapter) !== predicateBindingKey(facts.materialProviders[index]!))) {
    diagnostics.push(diagnostic("invalid", "release-predicate-oracle-binding-mismatch", "releaseClosures", "Each predicate adapter must be paired with one oracle and material provider carrying the same exact predicate and CommonEnvelope identity"));
  }
  for (const ref of refs) {
    const predicate = ref.predicateId === null
      ? undefined
      : currentManifest.predicateAdapters.find((entry) => entry.predicateId === ref.predicateId);
    if (ref.predicateId !== null && predicate === undefined) {
      diagnostics.push(diagnostic("invalid", "release-closure-predicate-missing", ref.entrypointId, "Stored release closure predicate is absent from the current generated manifest"));
      continue;
    }
    const binding = releaseBindingForRole(ref.role, currentManifest, predicate);
    const actual = releaseClosureRoleRef(receipt, ref.role, binding, diagnostics);
    if (actual === null) continue;
    if (actual.entrypoint !== ref.entrypoint || actual.modulePath !== ref.modulePath || actual.exportName !== ref.exportName || actual.predicateId !== ref.predicateId || actual.predicateSpecDigest !== ref.predicateSpecDigest || actual.predicateProgramDescriptorDigest !== ref.predicateProgramDescriptorDigest || actual.oracleProgramDescriptorDigest !== ref.oracleProgramDescriptorDigest || actual.adapterVersion !== ref.adapterVersion || actual.oracleVersion !== ref.oracleVersion || actual.compositionLeafDigest !== ref.compositionLeafDigest || actual.commonEnvelopeRoleContractVersion !== ref.commonEnvelopeRoleContractVersion || actual.materialProviderContractDigest !== ref.materialProviderContractDigest || actual.implementationExportDigest !== ref.implementationExportDigest || actual.closureDigest !== ref.closureDigest || actual.programInputSetRoot !== ref.programInputSetRoot) {
      diagnostics.push(diagnostic("invalid", "release-closure-fact-mismatch", ref.entrypointId, "Stored release closure facts do not match the current compiler-derived closure"));
    }
  }
  for (const oracle of facts.qualificationOracles) {
    assertReleaseOwnedClosuresDisjoint(receipt, facts.genericCore, oracle, diagnostics);
    assertReleaseOwnedClosuresDisjoint(receipt, facts.releaseRuntime, oracle, diagnostics);
    for (const adapter of facts.predicateAdapters) assertReleaseOwnedClosuresDisjoint(receipt, adapter, oracle, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, facts.genericCore, oracle, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, facts.releaseRuntime, oracle, diagnostics);
    for (const adapter of facts.predicateAdapters) assertReleaseClosureExcludesEntrypoint(receipt, adapter, oracle, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, facts.genericCore, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, facts.releaseRuntime, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, facts.qualifiedRunner, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, facts.qualifiedRunner, oracle, diagnostics);
  }
  for (const provider of facts.materialProviders) {
    assertReleaseOwnedClosuresDisjoint(receipt, facts.genericCore, provider, diagnostics);
    for (const adapter of facts.predicateAdapters) assertReleaseOwnedClosuresDisjoint(receipt, adapter, provider, diagnostics);
    for (const oracle of facts.qualificationOracles) assertReleaseOwnedClosuresDisjoint(receipt, oracle, provider, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, facts.genericCore, provider, diagnostics);
    for (const adapter of facts.predicateAdapters) assertReleaseClosureExcludesEntrypoint(receipt, adapter, provider, diagnostics);
    for (const oracle of facts.qualificationOracles) assertReleaseClosureExcludesEntrypoint(receipt, oracle, provider, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, provider, facts.genericCore, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, provider, facts.releaseRuntime, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, provider, facts.qualifiedRunner, diagnostics);
  }
  for (const adapter of facts.predicateAdapters) {
    assertReleaseOwnedClosuresDisjoint(receipt, facts.genericCore, adapter, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, facts.genericCore, adapter, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, adapter, facts.releaseRuntime, diagnostics);
  }
  for (let left = 0; left < facts.predicateAdapters.length; left += 1) {
    for (let right = left + 1; right < facts.predicateAdapters.length; right += 1) {
      assertReleaseOwnedClosuresDisjoint(receipt, facts.predicateAdapters[left]!, facts.predicateAdapters[right]!, diagnostics);
    }
  }
  for (let left = 0; left < facts.qualificationOracles.length; left += 1) {
    for (let right = left + 1; right < facts.qualificationOracles.length; right += 1) {
      assertReleaseOwnedClosuresDisjoint(receipt, facts.qualificationOracles[left]!, facts.qualificationOracles[right]!, diagnostics);
    }
  }
  assertReleaseClosureContains(receipt, facts.releaseRuntime, facts.genericCore, diagnostics);
  for (const adapter of facts.predicateAdapters) assertReleaseClosureContains(receipt, facts.releaseRuntime, adapter, diagnostics);
  for (const provider of facts.materialProviders) assertReleaseClosureContains(receipt, facts.releaseRuntime, provider, diagnostics);
  assertReleaseClosureContains(receipt, facts.qualifiedRunner, facts.releaseRuntime, diagnostics);
  validateProductionReleaseClosure(receipt, facts.releaseRuntime, diagnostics);
  validateProductionReleaseClosure(receipt, facts.qualifiedRunner, diagnostics);
  validateQualifiedRunnerCompilerClosure(receipt, facts.qualifiedRunner, diagnostics);
  const base = {
    schemaVersion: 1 as const,
    genericCore: facts.genericCore,
    qualifiedRunner: facts.qualifiedRunner,
    predicateAdapters: facts.predicateAdapters,
    qualificationOracles: facts.qualificationOracles,
    materialProviders: facts.materialProviders,
    releaseRuntime: facts.releaseRuntime,
    predicateCompositionRootDigest: facts.predicateCompositionRootDigest,
    commonEnvelopeRoleContractVersion: facts.commonEnvelopeRoleContractVersion,
    roleManifestRootDigest: facts.roleManifestRootDigest,
  };
  if (releaseClosureRootDigest(base) !== facts.rootDigest) diagnostics.push(diagnostic("invalid", "release-closure-root-mismatch", "releaseClosures.rootDigest", "Stored release closure root does not recompute"));
  const current = deriveReleaseClosureFacts(receipt, currentManifest);
  diagnostics.push(...current.diagnostics);
  if (current.facts === null || canonical(current.facts) !== canonical(facts)) {
    diagnostics.push(diagnostic("invalid", "release-closure-current-manifest-mismatch", "releaseClosures", "Stored release closure facts do not exactly equal facts derived from the current generated role manifest"));
  }
  return uniqueDiagnostics(diagnostics);
}

export interface ImplementationClosureQueryPolicy {
  /** Collector mode is explicitly non-authoritative and may inspect clean local fixtures. */
  readonly mode: "production" | "collector";
}

export interface QualifiedImplementationClosureObservationV1 {
  readonly entrypoint: string;
  readonly entrypointId: string;
  readonly closureDigest: string;
  readonly programInputSetRoot: string;
  readonly files: readonly ImplementationClosureFile[];
}

/**
 * Narrow compiler-fact projection for build tools. It carries no receipt,
 * validator callback, Program, AST, or authority constructor.
 */
export function queryImplementationClosureObservation(
  receipt: BoundaryReceipt,
  entrypointId: string,
  policy: ImplementationClosureQueryPolicy = { mode: "production" },
): QualifiedImplementationClosureObservationV1 | null {
  let denominator: Pick<BoundaryReceipt, "implementationClosures">;
  if (policy.mode === "collector") {
    if (receipt.schemaVersion !== 1 || receipt.gate !== "aloha.machine-enforced-boundary" || receipt.claims.productionAuthority !== "not-observed") return null;
    if (receipt.verdict !== "pass" || !receipt.candidate.clean || receipt.diagnostics.length !== 0) return null;
    denominator = receipt;
  } else {
    const issued = receipt !== null && typeof receipt === "object"
      ? ISSUED_PRODUCTION_BOUNDARY_RECEIPTS.get(receipt)
      : undefined;
    if (issued === undefined) return null;
    denominator = issued;
  }
  const closure = findImplementationClosureById(denominator, entrypointId);
  if (closure === null) return null;
  if (computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot || recomputeImplementationClosureDigest(closure) !== closure.closureDigest) return null;
  return Object.freeze({
    entrypoint: closure.entrypoint,
    entrypointId: closure.entrypointId,
    closureDigest: closure.closureDigest,
    programInputSetRoot: closure.programInputSetRoot,
    files: Object.freeze(closure.files.map(file => Object.freeze({ ...file }))),
  });
}

/**
 * Validate and query one exact closure. Collector mode is observation-only;
 * production mode additionally requires a pushed candidate and can never
 * accept an unpushed `requirePushed: false` fixture.
 */
export function validateAndQueryImplementationClosureDigest(
  receipt: BoundaryReceipt,
  entrypointId: string,
  policy: ImplementationClosureQueryPolicy = { mode: "production" },
): string | null {
  let denominator: Pick<BoundaryReceipt, "implementationClosures">;
  if (policy.mode === "collector") {
    if (receipt.schemaVersion !== 1 || receipt.gate !== "aloha.machine-enforced-boundary" || receipt.claims.productionAuthority !== "not-observed") return null;
    if (receipt.verdict !== "pass" || !receipt.candidate.clean || receipt.diagnostics.length !== 0) return null;
    denominator = receipt;
  } else {
    const issued = receipt !== null && typeof receipt === "object"
      ? ISSUED_PRODUCTION_BOUNDARY_RECEIPTS.get(receipt)
      : undefined;
    if (issued === undefined) return null;
    denominator = issued;
  }
  const closure = findImplementationClosureById(denominator, entrypointId);
  if (!closure || computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot || recomputeImplementationClosureDigest(closure) !== closure.closureDigest) return null;
  return closure.closureDigest;
}

function exactGitState(root: string, requirePushed: boolean, diagnostics: BoundaryDiagnostic[]): BoundaryReceipt["candidate"] {
  let branch: string | null = null;
  let headSha: string | null = null;
  let upstreamSha: string | null = null;
  let remoteRef: string | null = null;
  let remoteSha: string | null = null;
  let clean = false;
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("not a Git work tree");
    branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]) || null;
    headSha = git(root, ["rev-parse", "HEAD"]) || null;
    const status = execFileSync(BOUNDARY_GIT_EXECUTABLE_PATH, ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      env: boundaryGitEnvironment(),
    });
    clean = status.length === 0;
    if (!clean) diagnostics.push(diagnostic("invalid", "dirty-tree", ".", "Required gate denominator must be a clean work tree"));
    let upstreamRef: string | null = null;
    try { upstreamRef = git(root, ["rev-parse", "--symbolic-full-name", "@{upstream}"]) || null; } catch { upstreamRef = null; }
    const remoteTracking = upstreamRef !== null && /^refs\/remotes\/[^/]+\/.+$/.test(upstreamRef);
    if (upstreamRef && !remoteTracking) diagnostics.push(diagnostic("invalid", "upstream-not-remote-tracking", ".", `Upstream ${upstreamRef} is not a remote-tracking ref`));
    if (remoteTracking) {
      try { upstreamSha = git(root, ["rev-parse", "--verify", upstreamRef!]) || null; } catch { upstreamSha = null; }
    }
    if (!branch) diagnostics.push(diagnostic("invalid", "detached-head", ".", "Required gate needs a named candidate branch"));
    const canonicalUpstreamRef = branch === null ? null : `refs/remotes/origin/${branch}`;
    if (requirePushed && upstreamRef !== null && upstreamRef !== canonicalUpstreamRef) {
      diagnostics.push(diagnostic("invalid", "upstream-not-canonical-origin", ".", `Upstream ${upstreamRef} is not the canonical origin ref for ${branch ?? "detached HEAD"}`));
    }
    if (requirePushed && !upstreamSha) diagnostics.push(diagnostic("invalid", "unpushed-candidate", ".", "No upstream ref proves this candidate was pushed"));
    if (requirePushed && upstreamSha && headSha !== upstreamSha) diagnostics.push(diagnostic("invalid", "remote-not-at-head", ".", "HEAD is not the exact local upstream tip"));
    if (requirePushed
      && clean
      && branch !== null
      && headSha !== null
      && upstreamRef === canonicalUpstreamRef
      && upstreamSha === headSha) {
      remoteRef = `refs/heads/${branch}`;
      try {
        const output = execFileSync(BOUNDARY_GIT_EXECUTABLE_PATH, [
          "--no-replace-objects",
          "-c", "credential.helper=",
          "-c", "protocol.ext.allow=never",
          "ls-remote",
          "--exit-code",
          BOUNDARY_CANONICAL_REMOTE_URL_V1,
          remoteRef,
        ], {
          cwd: "/",
          encoding: "utf8",
          env: boundaryGitEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        const fields = output.split(/\s+/);
        if (fields.length === 2 && fields[1] === remoteRef && /^[0-9a-f]{40}$/.test(fields[0]!)) {
          remoteSha = fields[0]!;
        } else {
          diagnostics.push(diagnostic("invalid", "canonical-remote-response-invalid", ".", "Canonical remote returned a non-exact branch-tip record"));
        }
      } catch (error) {
        diagnostics.push(diagnostic("invalid", "canonical-remote-unreadable", ".", `Canonical remote branch tip could not be observed: ${String(error)}`));
      }
      if (remoteSha !== null && remoteSha !== headSha) {
        diagnostics.push(diagnostic("invalid", "canonical-remote-not-at-head", ".", "HEAD is not the exact canonical remote branch tip"));
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "git-state-unreadable", ".", String(error)));
  }
  return {
    gitRoot: root,
    branch,
    headSha,
    upstreamSha,
    remoteRef,
    remoteSha,
    clean,
    pushed: Boolean(headSha && upstreamSha && remoteSha && headSha === upstreamSha && headSha === remoteSha),
  };
}

function collectLanguageBuildFacts(
  root: string,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): LanguageBuildFactsV1 {
  const rustResult = collectRustBuildAdapterFacts(root, files);
  for (const item of rustResult.diagnostics) diagnostics.push(diagnostic(item.kind, item.code, item.path, item.message));
  if (files.some((file) => file.language === "rust") && rustResult.facts === null && rustResult.diagnostics.length === 0) {
    diagnostics.push(diagnostic("invalid", "rust-build-adapter-unavailable", ".", "Rust entered the denominator but the pinned Cargo/Rustc adapter produced no facts"));
  }

  const solidityDiagnostics: BoundaryDiagnostic[] = [];
  const solidity = collectFoundryBuildGraphFacts(root, files, (item) => solidityDiagnostics.push(item));
  diagnostics.push(...solidityDiagnostics);
  if (files.some((file) => file.language === "solidity") && solidity === null && solidityDiagnostics.length === 0) {
    diagnostics.push(diagnostic("invalid", "solidity-build-adapter-unavailable", ".", "Solidity entered the denominator but the pinned Forge/solc adapter produced no facts"));
  }

  const rootDigest = hashDomain("aloha/boundary/language-build-adapters/v1", {
    rust: rustResult.facts?.rootDigest ?? null,
    solidity: solidity?.rootDigest ?? null,
  });
  return Object.freeze({ rust: rustResult.facts, solidity, rootDigest });
}

function mutationKey(value: MutationExpectation): string {
  return `${value.caseId}|${value.path}|${value.offset}|${value.code}`;
}

export function verifyMutationCorpus(cases: readonly MutationCase[] = MUTATION_CORPUS): MutationResult[] {
  return cases.map((item) => {
    const actual = inspectSourceText(item.path, item.source, item.scanOptions).diagnostics.map((entry) => ({ caseId: item.caseId, path: entry.path, offset: entry.offset ?? -1, code: entry.code })).sort((a, b) => mutationKey(a).localeCompare(mutationKey(b)));
    const expected = [...item.expected].sort((a, b) => mutationKey(a).localeCompare(mutationKey(b)));
    const pass = actual.length === expected.length && actual.every((entry, index) => mutationKey(entry) === mutationKey(expected[index]));
    return { caseId: item.caseId, expected, actual, pass };
  });
}

const mutation = (caseId: string, path: string, source: string, code: string, token: string): MutationCase => ({
  caseId,
  path,
  source,
  expected: [{ caseId, path, offset: source.indexOf(token), code }],
});

/** Each case is independently scanned; no case can satisfy another case's expected multiset. */
export const MUTATION_CORPUS: readonly MutationCase[] = Object.freeze([
  mutation("require-alias", "fixture/require-alias.ts", "const load = require; load(name);", "ambiguous-loader-alias", "require"),
  mutation("create-require-alias", "fixture/create-require-alias.ts", "const req = createRequire(import.meta.url); req(name);", "dynamic-loader", "name"),
  mutation("dynamic-import-concat", "fixture/dynamic-import-concat.ts", "import('./safe.js' + suffix);", "dynamic-import-nonliteral", "'./safe.js'"),
  mutation("worker-alias", "fixture/worker-alias.ts", "new Worker('./worker.js' + suffix);", "worker-nonliteral", "'./worker.js'"),
  mutation("eval", "fixture/eval.ts", "eval(source);", "dynamic-code-eval", "eval"),
  mutation("function-constructor", "fixture/function.ts", "new Function(source);", "dynamic-code-eval", "Function"),
  {
    caseId: "acceptance-fs-process",
    path: "fixture/acceptance-fs-process.ts",
    source: "import fs from 'node:fs'; process.env.HOME;",
    scanOptions: { pureAcceptanceCore: true },
    expected: [
      { caseId: "acceptance-fs-process", path: "fixture/acceptance-fs-process.ts", offset: 15, code: "acceptance-environment-import" },
      { caseId: "acceptance-fs-process", path: "fixture/acceptance-fs-process.ts", offset: 26, code: "acceptance-environment-process" },
    ],
  },
  {
    caseId: "same-file-extra-diagnostics",
    path: "fixture/same-file-extra.ts",
    source: "require(prefix); eval(source);",
    expected: [
      { caseId: "same-file-extra-diagnostics", path: "fixture/same-file-extra.ts", offset: 8, code: "dynamic-loader" },
      { caseId: "same-file-extra-diagnostics", path: "fixture/same-file-extra.ts", offset: 17, code: "dynamic-code-eval" },
    ],
  },
]);

interface AttestationNamedDeclaration {
  readonly path: string;
  readonly name: string;
  readonly kind: ts.SyntaxKind;
  readonly exported: boolean;
  readonly offset: number;
}

const ATTESTATION_ENGINE_RUNTIME_EXPORTS = new Set([
  "createRejectionExecutorAuthorityIssuerInternal",
  "createRejectionFactRuntimeInternal",
  "createFrameworkFailureRuntimeInternal",
  "createAttestationServiceInternal",
  "probeRetryableCandidate",
  "probeRetryableCategory",
]);

const ATTESTATION_ENGINE_CANONICAL_NAMES = new Set([
  "AttestationValidationAuthorityV1",
  "validateCandidateFinalOutcome",
  "validateAttestationPartition",
  "assertPromotablePartition",
  "validateIdentityObservation",
  "identityObservationSemanticHash",
  "validateVerifiedPublication",
  "verifiedIdentitySubjectHash",
  "validateProbeReceipt",
]);

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function attestationNamedDeclarations(path: string, source: string): readonly AttestationNamedDeclaration[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations: AttestationNamedDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
        || ts.isClassDeclaration(node)
        || ts.isEnumDeclaration(node)
        || ts.isFunctionDeclaration(node))
      && node.name !== undefined
    ) {
      declarations.push({
        path,
        name: node.name.text,
        kind: node.kind,
        exported: hasExportModifier(node),
        offset: node.name.getStart(sourceFile),
      });
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declarations.push({
          path,
          name: declaration.name.text,
          kind: declaration.kind,
          exported: hasExportModifier(node),
          offset: declaration.name.getStart(sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

/**
 * Machine-enforced ownership for the Attestation contract surface.  Runtime
 * implementation may consume the public contract, but it cannot redeclare or
 * export a second validator/authority shape that checkpoint code could trust.
 */
export function validateAttestationContractOwnershipSources(
  sources: ReadonlyMap<string, string>,
  diagnostics: BoundaryDiagnostic[],
): void {
  const declarations = [...sources.entries()]
    .filter(([path]) => path.startsWith("packages/attestation/src/") && /\.[cm]?[jt]sx?$/.test(path))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, source]) => attestationNamedDeclarations(path, source));
  const authorityDeclarations = declarations.filter((item) => item.name === "AttestationValidationAuthorityV1");
  if (authorityDeclarations.length !== 1) {
    diagnostics.push(diagnostic(
      "fail",
      "attestation-validation-authority-declaration-count",
      ATTESTATION_PUBLIC_CONTRACT_PATH,
      `AttestationValidationAuthorityV1 must have one production declaration; observed ${authorityDeclarations.length}`,
    ));
  }
  const authority = authorityDeclarations[0];
  if (
    authority !== undefined
    && (
      authority.path !== ATTESTATION_PUBLIC_CONTRACT_PATH
      || authority.kind !== ts.SyntaxKind.InterfaceDeclaration
      || !authority.exported
    )
  ) {
    diagnostics.push(diagnostic(
      "fail",
      "attestation-validation-authority-owner",
      authority.path,
      "The unique AttestationValidationAuthorityV1 must be the exported interface owned by packages/attestation/src/index.ts",
      authority.offset,
    ));
  }

  const engineSource = sources.get(ATTESTATION_ENGINE_PATH);
  if (engineSource !== undefined) {
    const engineFile = ts.createSourceFile(ATTESTATION_ENGINE_PATH, engineSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const engineDeclarations = declarations.filter((item) => item.path === ATTESTATION_ENGINE_PATH);
    for (const declaration of engineDeclarations) {
      if (ATTESTATION_ENGINE_CANONICAL_NAMES.has(declaration.name)) {
        diagnostics.push(diagnostic(
          "fail",
          "attestation-engine-canonical-contract",
          ATTESTATION_ENGINE_PATH,
          `Runtime engine redeclares canonical Attestation contract ${declaration.name}`,
          declaration.offset,
        ));
      }
      if (declaration.exported && !ATTESTATION_ENGINE_RUNTIME_EXPORTS.has(declaration.name)) {
        diagnostics.push(diagnostic(
          "fail",
          "attestation-engine-public-contract-export",
          ATTESTATION_ENGINE_PATH,
          `Runtime engine exports undeclared contract surface ${declaration.name}`,
          declaration.offset,
        ));
      }
    }
    for (const statement of engineFile.statements) {
      if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement)) {
        diagnostics.push(diagnostic(
          "fail",
          "attestation-engine-public-contract-export",
          ATTESTATION_ENGINE_PATH,
          "Runtime engine may export only its exact named runtime constructors and probe entrypoints",
          statement.getStart(engineFile),
        ));
      }
    }
  }

  const publicShapeAssert = declarations.find((item) => (
    item.path === ATTESTATION_PUBLIC_CONTRACT_PATH
    && item.name === "assertAttestationValidationAuthority"
  ));
  if (publicShapeAssert !== undefined) {
    diagnostics.push(diagnostic(
      "fail",
      "attestation-public-shape-authority-assert",
      ATTESTATION_PUBLIC_CONTRACT_PATH,
      "The public contract may not expose a shape-only Attestation authority assertion",
      publicShapeAssert.offset,
    ));
  }
}

export function runBoundaryGate(options: BoundaryOptions = {}): BoundaryReceipt {
  const root = resolve(options.gitRoot ?? fileURLToPath(new URL("../../..", import.meta.url)));
  const requirePushed = options.requirePushed ?? true;
  const diagnostics: BoundaryDiagnostic[] = [];
  const candidate = exactGitState(root, requirePushed, diagnostics);
  const files = readTrackedFiles(root, diagnostics);
  if (files.length === 0) diagnostics.push(diagnostic("invalid", "empty-git-denominator", ".", "An empty or unreadable Git tree cannot receive boundary credit"));
  for (const path of FORBIDDEN_RELEASE_AUTHORING_PATHS) {
    if (files.some(file => file.path === path)) {
      diagnostics.push(diagnostic("fail", "production-advisory-authoring-path-forbidden", path, "Advisory-only release closure must not contain prepared-acceptance, package-writer, or publication-fence owners"));
    }
  }
  const attestationSources = new Map<string, string>();
  for (const file of files) {
    if (!file.path.startsWith("packages/attestation/src/") || (file.language !== "typescript" && file.language !== "javascript")) continue;
    try {
      attestationSources.set(file.path, readFileSync(abs(root, file.path), "utf8"));
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "attestation-contract-source-unreadable", file.path, String(error)));
    }
  }
  if (attestationSources.size > 0) validateAttestationContractOwnershipSources(attestationSources, diagnostics);
  const runtimeReleaseSources = new Map<string, string>();
  for (const path of [RUNTIME_RELEASE_PUBLIC_PATH, RUNTIME_RELEASE_BOOTSTRAP_PATH] as const) {
    try {
      runtimeReleaseSources.set(path, readFileSync(abs(root, path), "utf8"));
    } catch {
      // The source graph below reports missing production inputs.  Keep this
      // small source-only check non-authoritative when a local slice is absent.
    }
  }
  if (runtimeReleaseSources.size > 0) validateRuntimeReleaseBootstrapSources(runtimeReleaseSources, diagnostics);
  const searcherRuntimeSources = new Map<string, string>();
  for (const file of files) {
    if (!file.path.startsWith("apps/searcher-runtime/src/") || file.language !== "typescript") continue;
    try {
      searcherRuntimeSources.set(file.path, readFileSync(abs(root, file.path), "utf8"));
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "searcher-runtime-source-unreadable", file.path, String(error)));
    }
  }
  if (searcherRuntimeSources.size > 0) {
    validateSearcherRuntimeDeploymentStartupSources(searcherRuntimeSources, diagnostics);
  }
  const acceptanceCollectorSources = new Map<string, string>();
  for (const file of files) {
    if (!file.path.startsWith("acceptance/collectors/src/") || file.language !== "typescript") continue;
    try {
      acceptanceCollectorSources.set(file.path, readFileSync(abs(root, file.path), "utf8"));
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "acceptance-collector-source-unreadable", file.path, String(error)));
    }
  }
  if (acceptanceCollectorSources.size > 0) {
    validateArtifactLineageStageOneSources(acceptanceCollectorSources, diagnostics);
  }
  if (files.some(file => file.path === PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH)) {
    const preReleaseBoundarySources = new Map<string, string>();
    for (const path of [
      PRODUCTION_RELEASE_WORKFLOW_PATH,
      PRE_RELEASE_STAGING_PUBLIC_PATH,
      PRE_RELEASE_STAGING_OWNER_PATH,
      PRE_RELEASE_RUNTIME_RECEIPT_STATE_PATH,
      PRE_RELEASE_STAGING_SCHEMA_PATH,
      RELEASE_PACKAGER_PUBLIC_ROOT_PATH,
      RELEASE_DEPLOYMENT_PACKAGE_PATH,
      PRE_RELEASE_LAUNCHER_PATH,
      PRODUCTION_LAUNCHER_PATH,
      RUNTIME_BUNDLE_BUILDER_PATH,
      SEARCHER_RELEASE_RUNTIME_PATH,
      QUALIFIED_RELEASE_PUBLIC_RUNNER_STATE_PATH,
      RUNTIME_RELEASE_PERFORMANCE_POLICY_OWNER_PATH,
      ARTIFACT_LINEAGE_STAGE_ONE_STATE_PATH,
      ARTIFACT_LINEAGE_STAGE_TWO_GIT_OWNER_PATH,
      COLLECTOR_PREDICATE_MATERIAL_SOURCE_PATH,
    ] as const) {
      try {
        preReleaseBoundarySources.set(path, readFileSync(abs(root, path), "utf8"));
      } catch (error) {
        diagnostics.push(diagnostic("invalid", "pre-release-boundary-source-unreadable", path, String(error)));
      }
    }
    validatePreReleaseProductionBoundarySources(preReleaseBoundarySources, diagnostics);
    validatePreReleaseOwnerHostSources(preReleaseBoundarySources, diagnostics);
  }
  const packageData = readPackageManifests(root, files, diagnostics);
  const searcherRuntimePackage = packageData.manifests.get(SEARCHER_RUNTIME_PACKAGE_MANIFEST_PATH);
  if (searcherRuntimePackage !== undefined) {
    validateFixedSearcherReleaseRuntimeOwnerV1(searcherRuntimePackage, searcherRuntimeSources, diagnostics);
  }
  const finalPreReleasePackage = packageData.manifests.get(FINAL_PRE_RELEASE_PACKAGE_MANIFEST_PATH);
  if (finalPreReleasePackage !== undefined) {
    validateFixedFinalPreReleasePackageOwnerV1(finalPreReleasePackage, diagnostics);
    try {
      validateFinalPreReleaseCliSourceV1(
        readFileSync(abs(root, FINAL_PRE_RELEASE_CLI_PATH), "utf8"),
        diagnostics,
      );
    } catch (error) {
      diagnostics.push(diagnostic(
        "invalid",
        "final-pre-release-cli-source-unreadable",
        FINAL_PRE_RELEASE_CLI_PATH,
        String(error),
      ));
    }
  }
  const gateCorePackage = packageData.manifests.get(GATE_CORE_PACKAGE_PATH);
  if (gateCorePackage !== undefined) {
    validateGateCorePackageExports(GATE_CORE_PACKAGE_PATH, gateCorePackage, diagnostics);
  } else if (requirePushed) {
    diagnostics.push(diagnostic("invalid", "gate-core-package-required", GATE_CORE_PACKAGE_PATH, "The production boundary requires the fixed GateCore package and its exact generated runtime export"));
  }
  const schedulerTreeTracked = files.some((file) => file.path === "packages/scheduler/package.json" || file.path === "packages/scheduler/src/index.ts");
  let schedulerAuthoritySource: string | null = null;
  try {
    // Read the worktree path even while it is not yet in the Git denominator:
    // a hand-edited generated authority must be diagnosed specifically, not
    // hidden behind the generic dirty-tree result.
    schedulerAuthoritySource = readFileSync(abs(root, SCHEDULER_AUTHORITY_PATH), "utf8");
  } catch {
    schedulerAuthoritySource = null;
  }
  if (schedulerAuthoritySource !== null) {
    try {
      validateQualifiedExecutorAuthoritySource(schedulerAuthoritySource, diagnostics);
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "qualified-executor-authority-unreadable", SCHEDULER_AUTHORITY_PATH, String(error)));
    }
  } else if (requirePushed || schedulerTreeTracked) {
    diagnostics.push(diagnostic("invalid", "qualified-executor-authority-missing", SCHEDULER_AUTHORITY_PATH, "The scheduler production tree requires its exact generated null authority placeholder"));
  }
  const workPlaneTreeTracked = files.some((file) => file.path === "packages/work-plane/package.json" || file.path === "packages/work-plane/src/index.ts");
  let familyExecutionCompositionSource: string | null = null;
  try {
    familyExecutionCompositionSource = readFileSync(abs(root, FAMILY_EXECUTION_COMPOSITION_PATH), "utf8");
  } catch {
    familyExecutionCompositionSource = null;
  }
  if (familyExecutionCompositionSource !== null) {
    try {
      validateFamilyExecutionCompositionSource(familyExecutionCompositionSource, diagnostics);
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "family-execution-composition-unreadable", FAMILY_EXECUTION_COMPOSITION_PATH, String(error)));
    }
  } else if (requirePushed || workPlaneTreeTracked) {
    diagnostics.push(diagnostic("invalid", "family-execution-composition-missing", FAMILY_EXECUTION_COMPOSITION_PATH, "The work-plane production tree requires its exact generated null composition placeholder"));
  }
  const generatedGenerators = validateGeneratedTree(root, files, requirePushed, diagnostics);
  const languageBuild = collectLanguageBuildFacts(root, files, diagnostics);
  const configs = files.filter((file) => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file.path) || /(?:^|\/)jsconfig(?:\.[^/]+)?\.json$/.test(file.path)).map((file) => file.path).sort();
  if (files.some((file) => file.language === "typescript" || file.language === "javascript") && configs.length === 0) diagnostics.push(diagnostic("invalid", "tsconfig-missing", ".", "TS/JS denominator has no real compiler configuration"));
  const lockFiles = files.filter((file) => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file.path));
  const graph = sourceBuildGraph(root, files, configs, packageData.rootHash, generatedGenerators, diagnostics);
  if (graph.externalDependencies.some((specifier) => !specifier.startsWith("node:")) && lockFiles.length === 0) {
    diagnostics.push(diagnostic("invalid", "external-lock-missing", ".", "External package imports require a tracked lockfile bound into the compiler graph"));
  }
  const scannedFileSetRoot = hashDomain("aloha/boundary/scanned-file-set/v1", files);
  const compilerVersionRoot = hashDomain("aloha/boundary/compiler-version/v1", { package: "typescript", version: ts.version });
  const configRoots = hashDomain("aloha/boundary/compiler-configs/v1", configs.map((path) => ({ path, sha: files.find((file) => file.path === path)?.blobSha ?? null })));
  const externalDependencyRoot = hashDomain("aloha/boundary/external-dependencies/v1", {
    dependencies: graph.externalDependencies,
    lockFiles: lockFiles.map((file) => ({ path: file.path, sha: file.blobSha })),
  });
  const implementationClosures = buildImplementationClosures(
    root,
    files,
    graph.contexts,
    packageData.entrypoints,
    lockFiles,
    diagnostics,
  );
  if (searcherRuntimePackage !== undefined
    && fixedSearcherReleaseRuntimeClosureV1(implementationClosures) === null) {
    diagnostics.push(diagnostic(
      "invalid",
      "searcher-release-runtime-closure-owner",
      SEARCHER_RELEASE_RUNTIME_PATH,
      "Boundary must derive one fixed package-owned production runtime implementation closure",
    ));
  }
  const catalogVerification = validateCatalogGenerationVerification(
    root,
    files,
    scannedFileSetRoot,
    graph.compilerRoot,
    implementationClosures,
    diagnostics,
  );
  validateProductionRuntimeClosures({ implementationClosures }, files, diagnostics);
  validateReleaseGeneratorCompilerClosure(root, files, implementationClosures, diagnostics);
  const releaseRoleManifest = readGeneratedReleaseRoleManifest(root, files, diagnostics);
  const releaseRoleManifestCandidates = files.filter((file) => /(?:^|\/)(?:release-role|role)-manifest(?:\.generated)?\.(?:json|ts)$/.test(file.path));
  if ((requirePushed || files.some((file) => file.path === RELEASE_RUNTIME_PATH)) && releaseRoleManifest === null && releaseRoleManifestCandidates.length === 0) {
    diagnostics.push(diagnostic("invalid", "release-role-manifest-required", RELEASE_RUNTIME_PATH, "The production boundary requires exactly one generated GateCore release role manifest"));
  }
  if (releaseRoleManifest !== null) {
    diagnostics.push(...validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures }, releaseRoleManifest));
  }
  const releaseClosureDerivation = releaseRoleManifest === null
    ? { facts: null, diagnostics: [] as readonly BoundaryDiagnostic[] }
    : deriveReleaseClosureFacts({ implementationClosures }, releaseRoleManifest);
  diagnostics.push(...releaseClosureDerivation.diagnostics);
  const manifestRoot = hashDomain("aloha/boundary/manifest/v1", {
    scannedFileSetRoot,
    configs,
    configRoots,
    compilerVersionRoot,
    compilerGraphRoot: graph.compilerRoot,
    externalDependencyRoot,
    languageBuildRoot: languageBuild.rootDigest,
    packageManifestRoot: packageData.rootHash,
  });
  const mutationCorpus = verifyMutationCorpus();
  for (const result of mutationCorpus) if (!result.pass) diagnostics.push(diagnostic("fail", "mutation-expected-multiset", result.caseId, "Mutation actual diagnostics differ from its independent exact expected multiset"));
  const compiler: CompilerSummary = {
    typescriptVersion: ts.version,
    compilerVersionRoot,
    configPaths: configs,
    configRoots,
    graphRoot: graph.compilerRoot,
    packageManifestRoot: packageData.rootHash,
    externalDependencyRoot,
    languageBuildRoot: languageBuild.rootDigest,
    externalDependencies: graph.externalDependencies,
    workspaceNames: packageData.workspaceNames,
  };
  const finalDiagnostics = uniqueDiagnostics(diagnostics);
  const verdict = finalDiagnostics.some((item) => item.kind === "invalid") ? "invalid" : finalDiagnostics.length > 0 ? "fail" : "pass";
  const receipt: BoundaryReceipt = {
    schemaVersion: 1,
    gate: "aloha.machine-enforced-boundary",
    verdict,
    candidate,
    denominator: { scannedFileSetRoot, manifestRoot, files },
    compiler,
    languageBuild,
    graph: { nodes: graph.nodes, edges: graph.edges },
    implementationClosures,
    catalogVerification,
    releaseRoleManifest,
    releaseClosures: releaseClosureDerivation.facts,
    diagnostics: finalDiagnostics,
    mutationCorpus: { root: hashDomain("aloha/boundary/mutation-corpus/v1", mutationCorpus), cases: mutationCorpus },
    claims: { sourceBuildClosure: "observed", runtimeLegacyZero: "not-asserted", productionAuthority: "not-observed" },
  };
  if (requirePushed
    && receipt.verdict === "pass"
    && receipt.candidate.clean
    && receipt.candidate.pushed
    && receipt.candidate.headSha !== null
    && receipt.candidate.upstreamSha === receipt.candidate.headSha
    && receipt.candidate.remoteSha === receipt.candidate.headSha
    && receipt.candidate.remoteRef === `refs/heads/${receipt.candidate.branch}`
    && receipt.diagnostics.length === 0
    && receipt.releaseRoleManifest !== null
    && receipt.releaseClosures !== null) {
    const releaseClosures = Object.freeze({
      ...receipt.releaseClosures,
      genericCore: Object.freeze({ ...receipt.releaseClosures.genericCore }),
      qualifiedRunner: Object.freeze({ ...receipt.releaseClosures.qualifiedRunner }),
      predicateAdapters: Object.freeze(receipt.releaseClosures.predicateAdapters.map((value) => Object.freeze({ ...value }))),
      qualificationOracles: Object.freeze(receipt.releaseClosures.qualificationOracles.map((value) => Object.freeze({ ...value }))),
      materialProviders: Object.freeze(receipt.releaseClosures.materialProviders.map((value) => Object.freeze({ ...value }))),
      releaseRuntime: Object.freeze({ ...receipt.releaseClosures.releaseRuntime }),
    });
    const snapshot = Object.freeze({
      candidateGitRoot: receipt.candidate.gitRoot,
      candidateReleaseCommit: receipt.candidate.headSha,
      releaseRoleManifestRoot: receipt.releaseRoleManifest.rootDigest,
      qualifiedRunner: releaseClosures.qualifiedRunner,
    });
    const authoritativeImplementationClosures = freezeIssuedBoundaryValueV1(receipt.implementationClosures);
    ISSUED_PRODUCTION_BOUNDARY_RECEIPTS.set(receipt, Object.freeze({
      snapshot,
      releaseClosures,
      implementationClosures: authoritativeImplementationClosures,
      denominator: freezeIssuedBoundaryValueV1({
        scannedFileSetRoot: receipt.denominator.scannedFileSetRoot,
        manifestRoot: receipt.denominator.manifestRoot,
        files: receipt.denominator.files.map(file => ({ ...file })),
      }),
      compiler: freezeIssuedBoundaryValueV1({ ...receipt.compiler }),
      languageBuild: freezeIssuedBoundaryValueV1(structuredClone(receipt.languageBuild)),
      git: Object.freeze({
        branch: receipt.candidate.branch!,
        upstreamRef: `refs/remotes/origin/${receipt.candidate.branch!}`,
        remoteRef: receipt.candidate.remoteRef!,
        headSha: receipt.candidate.headSha!,
        upstreamSha: receipt.candidate.upstreamSha!,
        remoteSha: receipt.candidate.remoteSha!,
      }),
    }));
  }
  return receipt;
}

/**
 * Project only immutable source/build facts from a genuine pushed Boundary
 * pass. The process-local receipt registry is the authority: a structural
 * receipt, an unpushed fixture, or a caller-authored verdict cannot mint this
 * staged runtime denominator.
 */
export function issueRuntimeBoundaryProjectionV1(
  receipt: BoundaryReceipt,
): RuntimeBoundaryProjectionV1 {
  const issued = receipt !== null && typeof receipt === "object"
    ? ISSUED_PRODUCTION_BOUNDARY_RECEIPTS.get(receipt)
    : undefined;
  if (issued === undefined) {
    throw new TypeError("runtime boundary projection requires a process-issued requirePushed Boundary pass receipt");
  }
  const runtime = fixedSearcherReleaseRuntimeClosureV1(issued.implementationClosures);
  if (runtime === null) throw new TypeError("runtime boundary projection fixed runtime closure is not uniquely Boundary-derived");
  const selectedIds = new Set<string>([runtime.entrypointId]);
  for (const ref of [
    issued.releaseClosures.genericCore,
    issued.releaseClosures.qualifiedRunner,
    issued.releaseClosures.releaseRuntime,
    ...issued.releaseClosures.predicateAdapters,
    ...issued.releaseClosures.qualificationOracles,
    ...issued.releaseClosures.materialProviders,
  ]) selectedIds.add(ref.entrypointId);
  const selectedClosures = issued.implementationClosures
    .filter(closure => selectedIds.has(closure.entrypointId))
    .sort((left, right) => left.entrypointId.localeCompare(right.entrypointId));
  if (selectedClosures.length !== selectedIds.size) throw new TypeError("runtime boundary projection release closure is unresolved");

  const selectedPaths = new Set<string>();
  for (const closure of selectedClosures) {
    selectedPaths.add(closure.entrypoint);
    selectedPaths.add(closure.configPath);
    if (closure.packageManifestPath !== null) selectedPaths.add(closure.packageManifestPath);
    for (const file of closure.files) selectedPaths.add(file.path);
    for (const file of closure.configChain.files) selectedPaths.add(file.path);
  }
  for (const file of issued.denominator.files) {
    if (file.path.startsWith("runtime/revm-worker-rust/")
      || file.path.startsWith("contracts/src/")
      || file.path === "contracts/foundry.toml"
      || file.path === "contracts/foundry-toolchain.json"
      || file.path.startsWith("deploy/")) selectedPaths.add(file.path);
  }
  selectedPaths.add(PRODUCTION_LAUNCHER_PATH);
  const byPath = new Map(issued.denominator.files.map(file => [file.path, file]));
  const edgeMap = new Map<string, GraphEdge>();
  for (const closure of selectedClosures) {
    for (const edge of closure.edges) {
      edgeMap.set(`${edge.from}\0${edge.to}\0${edge.specifier}\0${edge.resolutionMode ?? ""}`, Object.freeze({ ...edge }));
    }
  }
  const selectedEdges = [...edgeMap].sort(([left], [right]) => left.localeCompare(right)).map(([, edge]) => edge);
  for (const edge of selectedEdges) {
    selectedPaths.add(edge.from);
    selectedPaths.add(edge.to);
  }
  const selectedFiles = [...selectedPaths].sort().map(path => {
    const file = byPath.get(path);
    if (file === undefined) throw new TypeError(`runtime boundary projection selected path is outside the Git denominator: ${path}`);
    return Object.freeze({ ...file });
  });
  const implementationClosures = selectedClosures.map(closure => Object.freeze({
    entrypoint: closure.entrypoint,
    entrypointId: closure.entrypointId,
    kind: closure.kind,
    packageName: closure.packageName,
    packageManifestPath: closure.packageManifestPath,
    configPath: closure.configPath,
    tsconfigRoot: closure.tsconfigRoot as Hash,
    optionsRoot: closure.optionsRoot as Hash,
    programInputSetRoot: closure.programInputSetRoot as Hash,
    closureDigest: closure.closureDigest as Hash,
  }));
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-boundary-projection" as const,
    candidate: Object.freeze({
      candidateReleaseCommit: issued.snapshot.candidateReleaseCommit,
      branch: issued.git.branch,
      upstreamRef: issued.git.upstreamRef,
      remoteRef: issued.git.remoteRef,
      headSha: issued.git.headSha,
      upstreamSha: issued.git.upstreamSha,
      remoteSha: issued.git.remoteSha,
      pushed: true,
      scannedFileSetRoot: issued.denominator.scannedFileSetRoot as Hash,
      boundaryManifestRoot: issued.denominator.manifestRoot as Hash,
      compilerVersionRoot: issued.compiler.compilerVersionRoot as Hash,
      compilerConfigRoot: issued.compiler.configRoots as Hash,
      compilerGraphRoot: issued.compiler.graphRoot as Hash,
      packageManifestRoot: issued.compiler.packageManifestRoot as Hash,
      externalDependencyRoot: issued.compiler.externalDependencyRoot as Hash,
      languageBuildRoot: issued.languageBuild.rootDigest as Hash,
      releaseRoleManifestRoot: issued.snapshot.releaseRoleManifestRoot as Hash,
      releaseClosureRoot: issued.releaseClosures.rootDigest as Hash,
    }),
    implementationClosures: Object.freeze(implementationClosures),
    selectedFiles: Object.freeze(selectedFiles) as unknown as RuntimeBoundaryProjectionPayloadV1["selectedFiles"],
    selectedEdges: Object.freeze(selectedEdges) as unknown as RuntimeBoundaryProjectionPayloadV1["selectedEdges"],
    languageBuild: issued.languageBuild as unknown as RuntimeBoundaryProjectionPayloadV1["languageBuild"],
    releaseClosures: issued.releaseClosures as unknown as RuntimeBoundaryProjectionPayloadV1["releaseClosures"],
  }) satisfies RuntimeBoundaryProjectionPayloadV1;
  return decodeRuntimeBoundaryProjectionV1(Object.freeze({
    ...payload,
    projectionRoot: runtimeBoundaryProjectionRootV1(payload),
  }));
}

/** Build and bind the one qualified pre-release controller through the same
 * pushed Boundary receipt without adding it to the searcher runtime closure.
 * The returned root is release evidence for B authorization, not a staged
 * searcher artifact and not a producer verdict. */
export function issueQualifiedPreReleaseControllerBoundaryEvidenceV1(
  receipt: BoundaryReceipt,
  repositoryRootValue: string,
): QualifiedPreReleaseControllerBoundaryEvidenceV1 {
  const issued = receipt !== null && typeof receipt === "object"
    ? ISSUED_PRODUCTION_BOUNDARY_RECEIPTS.get(receipt)
    : undefined;
  if (issued === undefined) {
    throw new TypeError("qualified pre-release controller evidence requires a process-issued pushed Boundary pass");
  }
  const runtime = fixedSearcherReleaseRuntimeClosureV1(issued.implementationClosures);
  if (runtime === null) {
    throw new TypeError("qualified pre-release controller evidence fixed runtime closure is not uniquely Boundary-derived");
  }
  if (runtime.files.some(file => file.path.startsWith("tools/pre-release-restart-controller/"))) {
    throw new TypeError("qualified pre-release controller entered the searcher runtime selected closure");
  }
  if (runtime.files.some(file => file.path === FINAL_PRE_RELEASE_CLI_PATH || file.path === FINAL_PRE_RELEASE_RUNNER_PATH)) {
    throw new TypeError("final pre-release host entered the searcher runtime selected closure");
  }
  const finalCliClosure = fixedFinalPreReleaseCliClosureV1(issued.implementationClosures);
  if (finalCliClosure === null) {
    throw new TypeError("qualified pre-release controller requires the unique fixed same-process final CLI Boundary closure");
  }
  const closure = fixedPreReleaseRestartControllerClosureV1(issued.implementationClosures);
  if (closure === null) throw new TypeError("qualified pre-release controller Boundary package closure is not unique");
  const controller = buildExactPreReleaseRestartControllerArtifactV1(
    repositoryRootValue,
    issued.snapshot.candidateReleaseCommit,
  );
  const controllerMetafile = observePreReleaseControllerMetafileV1(repositoryRootValue);
  const observedControllerSourceInputRoot = hashDomain(
    "aloha/pre-release-restart-controller-source-inputs/v1",
    controller.sourceInputs,
  );
  const observedControllerImplementationClosureDigest = hashDomain(
    "aloha/pre-release-restart-controller-build-closure/v1",
    {
      bundleSha256: controller.sha256,
      sourceInputRoot: controller.sourceInputRoot,
      metafileRoot: controller.metafileRoot,
      externalBuiltins: controller.externalBuiltins,
      controllerSystemdUnitSha256: controller.controllerSystemdUnitSha256,
      targetSystemdUnitSha256: controller.targetSystemdUnitSha256,
      installContract: controller.installContract,
    },
  );
  if (controller.candidateReleaseCommit !== issued.snapshot.candidateReleaseCommit
    || controller.installContract.searcherRuntimeBundleMember !== false
    || controller.installContract.installOwner !== "@aloha/runtime-release-packager/final-pre-release-runner"
    || controller.sourceInputRoot !== observedControllerSourceInputRoot
    || controller.implementationClosureDigest !== observedControllerImplementationClosureDigest
    || controller.metafileRoot !== controllerMetafile.metafileRoot
    || canonical(controller.sourceInputs) !== canonical(controllerMetafile.sourceInputs)
    || canonical(controller.externalBuiltins) !== canonical(controllerMetafile.externalBuiltins)) {
    throw new TypeError("qualified pre-release controller exact artifact identity mismatch");
  }
  validatePreReleaseControllerCompilerMetafileEdgesV1(
    closure,
    controller.sourceInputs.map(input => input.path),
    new Map(controller.sourceInputs.map(input => [
      input.path,
      readFileSync(join(repositoryRootValue, input.path), "utf8"),
    ])),
    controllerMetafile.internalEdges,
  );
  const denominatorByPath = new Map(issued.denominator.files.map(file => [file.path, file]));
  const closureFilesByPath = new Map(closure.files.map(file => [file.path, file]));
  const closureTrackedInputsByPath = new Map(closure.programInputs
    .filter(input => input.kind === "tracked" && input.logicalPath.startsWith("repo/"))
    .map(input => [input.logicalPath.slice("repo/".length), input]));
  for (let index = 0; index < controller.sourceInputs.length; index += 1) {
    const input = controller.sourceInputs[index]!;
    if (index > 0 && controller.sourceInputs[index - 1]!.path >= input.path) {
      throw new TypeError("qualified pre-release controller source inputs are not strictly sorted");
    }
    const boundaryFile = denominatorByPath.get(input.path);
    const closureFile = closureFilesByPath.get(input.path);
    const compilerInput = closureTrackedInputsByPath.get(input.path);
    if (boundaryFile === undefined
      || boundaryFile.contentSha256 !== input.contentSha256
      || boundaryFile.byteLength !== Number(input.byteLength)
      || closureFile === undefined
      || closureFile.contentSha256 !== input.contentSha256
      || closureFile.byteLength !== Number(input.byteLength)
      || compilerInput === undefined
      || compilerInput.contentSha256 !== input.contentSha256
      || compilerInput.byteLength !== Number(input.byteLength)) {
      throw new TypeError(`qualified pre-release controller source input is outside the fixed CLI compiler closure: ${input.path}`);
    }
  }
  const exactExternalBuiltins = ["node:child_process", "node:crypto", "node:fs", "node:sqlite", "node:util"];
  if (controller.externalBuiltins.length !== exactExternalBuiltins.length
    || controller.externalBuiltins.some((value, index) => value !== exactExternalBuiltins[index])) {
    throw new TypeError("qualified pre-release controller external builtin denominator mismatch");
  }
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.qualified-pre-release-controller-boundary-evidence" as const,
    candidateReleaseCommit: controller.candidateReleaseCommit,
    controllerBundleSha256: controller.sha256,
    controllerSourceInputRoot: controller.sourceInputRoot,
    controllerMetafileRoot: controller.metafileRoot,
    controllerImplementationClosureDigest: controller.implementationClosureDigest,
    boundaryImplementationClosureDigest: closure.closureDigest as Hash,
    boundaryProgramInputSetRoot: closure.programInputSetRoot as Hash,
    controllerSystemdUnitSha256: controller.controllerSystemdUnitSha256,
    targetSystemdUnitSha256: controller.targetSystemdUnitSha256,
    installContract: controller.installContract,
    externalBuiltins: controller.externalBuiltins,
    searcherRuntimeBundleMember: false as const,
  });
  return freezeIssuedBoundaryValueV1({
    ...payload,
    evidenceRoot: hashDomain("aloha/qualified-pre-release-controller-boundary-evidence/v1", payload) as Hash,
  }) as QualifiedPreReleaseControllerBoundaryEvidenceV1;
}

/**
 * Exact-join an already verified external V3 approval to facts observed by
 * this process. Structural/cloned receipts are rejected before any digest is
 * compared, so callers cannot author their own closure denominator.
 */
export function assertQualifiedRunnerApprovalJoinsBoundaryReceiptV1(
  receipt: BoundaryReceipt,
  approval: QualifiedRunnerReleaseApprovalBindingV1,
  predicateQualifications: readonly QualifiedRunnerPredicateQualificationBindingV1[],
): QualifiedRunnerBoundarySnapshotV1 {
  const issued = receipt !== null && typeof receipt === "object"
    ? ISSUED_PRODUCTION_BOUNDARY_RECEIPTS.get(receipt)
    : undefined;
  if (issued === undefined) {
    throw new TypeError("qualified runner boundary receipt was not issued as a successful production observation");
  }
  const snapshot = issued.snapshot;
  const closures = issued.releaseClosures;
  if (approval.candidateReleaseCommit !== snapshot.candidateReleaseCommit
    || approval.releaseRoleManifestRoot !== snapshot.releaseRoleManifestRoot
    || approval.predicateCompositionRootDigest !== closures.predicateCompositionRootDigest
    || approval.gateCoreRuntimeClosureDigest !== closures.releaseRuntime.closureDigest
    || approval.gateCoreImplementationClosureDigest !== closures.genericCore.closureDigest
    || approval.qualifiedRunnerImplementationClosureDigest !== snapshot.qualifiedRunner.closureDigest
    || approval.qualifiedRunnerImplementationExportDigest !== snapshot.qualifiedRunner.implementationExportDigest) {
    throw new TypeError("external V3 approval does not exact-join the compiler-derived qualified runner");
  }
  const requirements = new Map<string, QualifiedRunnerReleaseRequirementBindingV1>();
  for (const requirement of approval.releaseAcceptanceRequirements) {
    if (requirements.has(requirement.predicateId)) throw new TypeError("external V3 approval contains a duplicate predicate requirement");
    requirements.set(requirement.predicateId, requirement);
  }
  const qualifications = new Map<string, QualifiedRunnerPredicateQualificationBindingV1>();
  for (const qualification of predicateQualifications) {
    if (qualifications.has(qualification.release.predicateId)) throw new TypeError("external qualification denominator contains a duplicate predicate");
    qualifications.set(qualification.release.predicateId, qualification);
  }
  if (requirements.size !== closures.predicateAdapters.length || qualifications.size !== closures.predicateAdapters.length) {
    throw new TypeError("external qualification denominator does not equal the compiler-derived predicate set");
  }
  for (const [index, adapter] of closures.predicateAdapters.entries()) {
    const predicateId = adapter.predicateId;
    const oracle = closures.qualificationOracles[index]!;
    if (predicateId === null) throw new TypeError("compiler-derived predicate identity is unavailable");
    const requirement = requirements.get(predicateId);
    const qualification = qualifications.get(predicateId);
    const verifier = qualification?.verifierCertificate;
    const release = qualification?.release;
    if (requirement === undefined || qualification === undefined || verifier === undefined || release === undefined
      || requirement.predicateSpecDigest !== adapter.predicateSpecDigest
      || requirement.predicateCompositionLeafDigest !== adapter.compositionLeafDigest
      || requirement.verifierCertificateId !== verifier.certificateId
      || release.predicateSpecDigest !== adapter.predicateSpecDigest
      || release.predicateCompositionLeafDigest !== adapter.compositionLeafDigest
      || release.predicateCompositionRootDigest !== closures.predicateCompositionRootDigest
      || release.gateCoreRuntimeClosureDigest !== closures.releaseRuntime.closureDigest
      || release.gateCoreImplementationClosureDigest !== closures.genericCore.closureDigest
      || release.verifierQualificationId !== verifier.certificateId
      || verifier.predicateSpecDigest !== adapter.predicateSpecDigest
      || verifier.predicateImplementationDigest !== adapter.closureDigest
      || verifier.predicateImplementationExportDigest !== adapter.implementationExportDigest
      || verifier.predicateProgramDescriptorDigest !== adapter.predicateProgramDescriptorDigest
      || verifier.oracleProgramDescriptorDigest !== adapter.oracleProgramDescriptorDigest
      || verifier.oracleImplementationClosureDigest !== oracle.closureDigest
      || verifier.oracleImplementationExportDigest !== oracle.implementationExportDigest
      || verifier.predicateCompositionLeafDigest !== adapter.compositionLeafDigest
      || verifier.gateCoreImplementationClosureDigest !== closures.genericCore.closureDigest) {
      throw new TypeError(`predicate qualification does not exact-join compiler-derived closure ${predicateId}`);
    }
  }
  return snapshot;
}

/**
 * Emit a receipt without first materialising its complete canonical encoding.
 * A production checkout can contain thousands of isolated compiler closures;
 * joining that encoding into one V8 string can exceed the string length limit
 * even though the observed facts and their digests are valid.
 */
export function writeReceipt(receipt: BoundaryReceipt, sink: CanonicalSink): void {
  writeCanonical(receipt, sink);
  sink("\n");
}

/** Convenience form for bounded fixtures and callers that explicitly need a string. */
export function formatReceipt(receipt: BoundaryReceipt): string {
  const chunks: string[] = [];
  writeReceipt(receipt, (chunk) => chunks.push(chunk));
  return chunks.join("");
}

function implementationClosureSetRootV1(
  closures: readonly ImplementationClosure[],
): string {
  const hash = createHash("sha256")
    .update("aloha/boundary/implementation-closure-set/v1")
    .update("\0")
    .update("[");
  closures.forEach((closure, index) => {
    if (index > 0) hash.update(",");
    writeCanonical({
      entrypointId: closure.entrypointId,
      closureDigest: closure.closureDigest,
    }, (chunk) => hash.update(chunk));
  });
  return `0x${hash.update("]").digest("hex")}`;
}

/**
 * Project the complete in-process fact tree to fixed-cardinality machine
 * output.  Every expanded collection is retained by an already validated
 * root or by a root computed incrementally here; no compiler input or
 * closure is removed from the gate's validation denominator.
 */
export function createBoundaryMachineReceiptV1(
  receipt: BoundaryReceipt,
): BoundaryMachineReceiptV1 {
  const base: Omit<BoundaryMachineReceiptV1, "rootDigest"> = {
    schemaVersion: 1,
    kind: "aloha.machine-enforced-boundary-receipt",
    gate: receipt.gate,
    verdict: receipt.verdict,
    candidate: receipt.candidate,
    roots: {
      scannedFileSetRoot: receipt.denominator.scannedFileSetRoot,
      boundaryManifestRoot: receipt.denominator.manifestRoot,
      compilerVersionRoot: receipt.compiler.compilerVersionRoot,
      compilerConfigRoot: receipt.compiler.configRoots,
      compilerGraphRoot: receipt.compiler.graphRoot,
      packageManifestRoot: receipt.compiler.packageManifestRoot,
      externalDependencyRoot: receipt.compiler.externalDependencyRoot,
      languageBuildRoot: receipt.languageBuild.rootDigest,
      implementationClosureSetRoot: implementationClosureSetRootV1(receipt.implementationClosures),
      catalogVerificationRoot: receipt.catalogVerification?.receiptRoot ?? null,
      releaseRoleManifestRoot: receipt.releaseRoleManifest?.rootDigest ?? null,
      releaseClosureRoot: receipt.releaseClosures?.rootDigest ?? null,
      diagnosticSetRoot: hashDomain("aloha/boundary/diagnostic-set/v1", receipt.diagnostics),
      mutationCorpusRoot: receipt.mutationCorpus.root,
    },
    counts: {
      trackedFiles: receipt.denominator.files.length,
      graphNodes: receipt.graph.nodes.length,
      graphEdges: receipt.graph.edges.length,
      implementationClosures: receipt.implementationClosures.length,
      implementationCompilerInputs: receipt.implementationClosures.reduce(
        (count, closure) => count + closure.programInputs.length,
        0,
      ),
      diagnostics: receipt.diagnostics.length,
      mutationCases: receipt.mutationCorpus.cases.length,
    },
    claims: receipt.claims,
  };
  return Object.freeze({
    ...base,
    rootDigest: hashDomain("aloha/boundary/machine-receipt/v1", base),
  });
}

/** Emit only the bounded content-addressed Boundary machine receipt. */
export function writeBoundaryMachineReceiptV1(
  receipt: BoundaryReceipt,
  sink: CanonicalSink,
): void {
  writeCanonical(createBoundaryMachineReceiptV1(receipt), sink);
  sink("\n");
}
