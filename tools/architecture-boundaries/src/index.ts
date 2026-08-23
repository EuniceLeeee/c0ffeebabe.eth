import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  sealCatalogCompilerClosureFacts,
  type CatalogCompilerClosureFactV1,
} from "../../../specs/catalog-compiler/src/index.ts";

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
  readonly externalDependencies: readonly string[];
  readonly workspaceNames: readonly string[];
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
 * Semantic release roles are references to compiler-derived closures, never a
 * manually maintained file list.  The generated manifest is supplied by
 * release governance; this package only resolves the exact entrypoint id and
 * recomputes its compiler closure facts.
 */
export type ReleaseClosureRoleV1 =
  | "generic-core"
  | "predicate-adapter"
  | "qualification-oracle"
  | "release-runtime";

/** A generated release manifest binding one compiler closure to one module export. */
export interface ReleaseRoleBindingV1 {
  readonly entrypointId: string;
  readonly modulePath: string;
  readonly exportName: string;
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
  /** Qualification-only oracle bound to this predicate, not a global oracle. */
  readonly oracleEntrypointId: string;
  readonly oracleModulePath: string;
  readonly oracleExportName: string;
}

/**
 * Generated, untrusted release-role facts.  The boundary recomputes every
 * digest and checks the bindings against compiler-visible source; callers may
 * not select a role by filename convention alone.
 */
export interface ReleaseRoleManifestV1 {
  readonly schemaVersion: 1;
  readonly genericCore: ReleaseRoleBindingV1;
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
  readonly implementationExportDigest: string | null;
  readonly closureDigest: string;
  readonly programInputSetRoot: string;
}

export interface ReleaseClosureFactsV1 {
  readonly schemaVersion: 1;
  readonly genericCore: ReleaseClosureRefV1;
  readonly predicateAdapters: readonly ReleaseClosureRefV1[];
  readonly qualificationOracles: readonly ReleaseClosureRefV1[];
  readonly releaseRuntime: ReleaseClosureRefV1;
  readonly predicateCompositionRootDigest: string;
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
    readonly clean: boolean;
    readonly pushed: boolean;
  };
  readonly denominator: {
    readonly scannedFileSetRoot: string;
    readonly manifestRoot: string;
    readonly files: readonly TrackedFile[];
  };
  readonly compiler: CompilerSummary;
  readonly graph: {
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly GraphEdge[];
  };
  readonly implementationClosures: readonly ImplementationClosure[];
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
const DECLARED_SOURCE_ROOTS = new Set(["acceptance", "apps", "families", "packages", "specs", "strategies", "tools", "runtime", "src"]);
const NODE_BUILTIN_PREFIXES = ["node:"];
const PURE_GOVERNANCE_NODE_BUILTINS = new Set(["node:crypto", "node:util"]);
const GATE_CORE_PACKAGE_PATH = "acceptance/gate-core/package.json";
const RELEASE_GENERIC_CORE_PATH = "acceptance/gate-core/src/index.ts";
const RELEASE_RUNTIME_PATH = "acceptance/gate-core/src/generated/release-runtime.ts";
const GATE_CORE_RELEASE_TARGET = "./src/generated/release-runtime.ts";
const RELEASE_COMPOSITION_PATH = "acceptance/gate-core/src/release-composition.ts";
const RELEASE_PREDICATE_COMPOSITION_PATH = "acceptance/gate-core/src/generated/predicate-composition.ts";
const RELEASE_AUTHORITY_PATH = "acceptance/gate-core/src/generated/release-authority.ts";
const SCHEDULER_AUTHORITY_PATH = "packages/scheduler/src/generated/qualified-executor-authority.ts";
const FAMILY_EXECUTION_COMPOSITION_PATH = "packages/work-plane/src/generated/family-execution-composition.ts";
const RUNTIME_RELEASE_PUBLIC_PATH = "packages/runtime-release-authority/src/index.ts";
const RUNTIME_RELEASE_BOOTSTRAP_PATH = "packages/runtime-release-authority/src/internal/bootstrap.ts";
const RUNTIME_RELEASE_REVM_OWNER_PATH = "packages/runtime-release-authority/src/internal/revm-worker-owner.ts";
const RUNTIME_RELEASE_READY_BINDING_OWNER_PATH = "packages/runtime-release-authority/src/internal/ready-binding-owner.ts";
const RUNTIME_RELEASE_READY_BINDING_CONSUMER_PATH = "packages/runtime-release-authority/src/internal/ready-binding-consumer.ts";
const REVM_WORKER_PROTOCOL_PATH = "runtime/revm-workers/src/protocol.ts";
const REVM_WORKER_LIFECYCLE_PATH = "runtime/revm-workers/src/lifecycle.ts";
const REVM_WORKER_AUTHORITY_PATH = "runtime/revm-workers/src/internal/authority.ts";
const RELEASE_AUTHORITY_SPEC_PATH = "specs/release-authority/src/index.ts";
const ATTESTATION_PUBLIC_CONTRACT_PATH = "packages/attestation/src/index.ts";
const ATTESTATION_ENGINE_PATH = "packages/attestation/src/internal/engine.ts";
const RELEASE_LEDGER_PATH = "acceptance/gate-core/src/release-role-manifest.ledger.json";
const RELEASE_GENERATOR_CLI_PATH = "tools/release-role-manifest/src/cli.ts";
const RELEASE_GENERATOR_INDEX_PATH = "tools/release-role-manifest/src/index.ts";
const RELEASE_GENERATED_OUTPUT_PATHS = Object.freeze([
  "acceptance/gate-core/src/generated/predicate-composition.ts",
  "acceptance/gate-core/src/generated/release-role-manifest.ts",
  RELEASE_RUNTIME_PATH,
].sort());
const RELEASE_FIXED_OUTPUT_PATHS = Object.freeze([RELEASE_AUTHORITY_PATH].sort());
const RELEASE_OUTPUT_PATHS = Object.freeze([...RELEASE_GENERATED_OUTPUT_PATHS, ...RELEASE_FIXED_OUTPUT_PATHS].sort());

// Family code is intentionally default-deny against the central tree.  These
// are protocol-neutral contracts/codecs only; adding a concrete package here
// would turn a Family-specific dependency into a central escape hatch.
const FAMILY_CENTRAL_IMPORT_ALLOWLIST = Object.freeze([
  "packages/family-sdk/runtime-refs/",
  "packages/capability-contracts/",
  "packages/canonical-codec/",
  // Only the separately frozen pure-contract subtree is a Family dependency;
  // the package root and closure/build helpers remain default-deny.
  "packages/artifact-fingerprint/src/pure/",
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

// These public package roots still mix a constructor/issuer with ordinary
// ports.  They are sensitive until physically split; listing them here makes
// direct runtime imports fail closed instead of hiding behind a public index.
const SENSITIVE_PUBLIC_CONSTRUCTOR_PATHS = new Set([
  "packages/checkpoint/src/index.ts",
  "packages/durable-store/src/index.ts",
  "packages/scheduler/src/index.ts",
  "packages/work-plane/src/index.ts",
]);

// These are current non-public constructor/issuer paths.  `/src/internal/`
// itself is also sensitive below, so a future internal constructor cannot be
// reached merely because it was omitted from this list.
const KNOWN_AUTHORITY_CONSTRUCTOR_PATHS = new Set([
  "packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts",
  "packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts",
  "packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts",
  "packages/attestation/src/internal-authority.ts",
  "packages/work-plane/src/internal/family-execution-port.ts",
  "packages/candidate-partition-runtime/src/internal/reader-state.ts",
  "packages/candidate-partition-runtime/src/internal/reader-issuer.ts",
  "packages/candidate-partition-runtime/src/internal/reader-consumer.ts",
  "packages/checkpoint/src/candidate-partition.ts",
  "packages/checkpoint/src/sealed-run.ts",
  "packages/sealed-run-runtime/src/internal/reader-state.ts",
  "packages/sealed-run-runtime/src/internal/reader-issuer.ts",
  "packages/sealed-run-runtime/src/internal/reader-consumer.ts",
  "specs/candidate-partition-authority/src/internal/issuer-state.ts",
  "specs/candidate-partition-authority/src/internal/issuer-owner.ts",
  "specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
]);

// Only the declaring owner may import the current internal constructor.  This
// is an exact edge manifest, not a package-wide or wildcard exception.
const AUTHORITY_OWNER_EDGES = new Set([
  "packages/runtime-release-authority/src/index.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/index.ts\u2192packages/runtime-release-authority/src/internal/bootstrap.ts",
  "packages/runtime-release-authority/src/internal/authority-consumer.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/authority-consumer.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts\u2192packages/runtime-release-authority/src/index.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-owner.ts",
  "packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts\u2192packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts",
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
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/attestation/src/internal/composition.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/checkpoint/src/candidate-partition.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/checkpoint/src/index.ts",
  "packages/runtime-release-authority/src/internal/bootstrap.ts\u2192packages/work-plane/src/internal/family-execution-port.ts",
  `packages/runtime-release-authority/src/internal/bootstrap.ts\u2192${RUNTIME_RELEASE_REVM_OWNER_PATH}`,
  `packages/runtime-release-authority/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_OWNER_PATH}`,
  `packages/runtime-release-authority/src/internal/ready-binding-consumer.ts\u2192${RUNTIME_RELEASE_READY_BINDING_OWNER_PATH}`,
  `packages/ready-generation/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_CONSUMER_PATH}`,
  `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192packages/scheduler/src/internal/authority-consumer.ts`,
  `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
  `${REVM_WORKER_LIFECYCLE_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
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
  "packages/checkpoint/src/sealed-run.ts\u2192packages/sealed-run-runtime/src/internal/reader-issuer.ts",
  "packages/ready-generation/src/index.ts\u2192packages/sealed-run-runtime/src/internal/reader-consumer.ts",
  "packages/sealed-run-runtime/src/internal/reader-issuer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts",
  "packages/sealed-run-runtime/src/internal/reader-consumer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts",
  "packages/checkpoint/src/index.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
  "packages/checkpoint/test/candidate-partition-authority-fixture.ts\u2192specs/candidate-partition-authority/src/internal/issuer-owner.ts",
  "specs/candidate-partition-authority/src/internal/issuer-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts",
  "specs/candidate-partition-authority/src/internal/issuer-consumer.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts",
]);

const AUTHORITY_NAMED_IMPORTS = new Map<string, readonly string[]>([
  [
    "packages/runtime-release-authority/src/index.ts\u2192packages/runtime-release-authority/src/internal/state.ts",
    ["registerRuntimeReleaseAuthority", "stateForRuntimeReleaseCapability"],
  ],
  [
    "packages/runtime-release-authority/src/index.ts\u2192packages/runtime-release-authority/src/internal/bootstrap.ts",
    ["buildRuntimeReleaseComposition"],
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
    `packages/runtime-release-authority/src/internal/bootstrap.ts\u2192${RUNTIME_RELEASE_REVM_OWNER_PATH}`,
    ["issueRuntimeReleaseExecutorLeaseV1"],
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
  ["packages/ready-generation/src/index.ts\u2192packages/sealed-run-runtime/src/internal/reader-consumer.ts", ["assertCheckpointSealedRunReader"]],
  ["packages/sealed-run-runtime/src/internal/reader-issuer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts", ["registerSealedRunReader"]],
  ["packages/sealed-run-runtime/src/internal/reader-consumer.ts\u2192packages/sealed-run-runtime/src/internal/reader-state.ts", ["isSealedRunReader"]],
  ["packages/checkpoint/src/index.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts", ["assertIssuedCandidatePartitionProofIssuer"]],
  ["specs/candidate-partition-authority/src/internal/issuer-owner.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts", ["registerCandidatePartitionProofIssuer"]],
  ["specs/candidate-partition-authority/src/internal/issuer-consumer.ts\u2192specs/candidate-partition-authority/src/internal/issuer-state.ts", ["isCandidatePartitionProofIssuer"]],
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
]);

/** Consumers that must pass an owner-issued process-local port through an
 * exact consumer guard.  A matching structural TypeScript interface is not
 * enough and must not silently become a second authority path. */
const REQUIRED_AUTHORITY_IMPORT_EDGES = new Set([
  `packages/ready-generation/src/index.ts\u2192${RUNTIME_RELEASE_READY_BINDING_CONSUMER_PATH}`,
  "packages/checkpoint/src/index.ts\u2192specs/candidate-partition-authority/src/internal/issuer-consumer.ts",
  "packages/attestation/src/internal/composition-resolution.ts\u2192packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts",
  `${REVM_WORKER_LIFECYCLE_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
  `${RUNTIME_RELEASE_REVM_OWNER_PATH}\u2192${REVM_WORKER_AUTHORITY_PATH}`,
]);

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite hash input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new TypeError("unsupported hash input");
}

function hashDomain(domain: string, value: unknown): string {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
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
  entry: Omit<ReleasePredicateBomEntryV1, "entrypointId" | "oracleEntrypointId" | "compositionLeafDigest">,
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
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

function classify(path: string): { language: Language; fileClass: FileClass; sourceLike: boolean } {
  const normalized = posixPath(path);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extension = extname(base).toLowerCase();
  const language = SOURCE_EXTENSIONS.get(extension) ?? "metadata";
  const parts = normalized.split("/");
  const top = parts[0] ?? "";
  const generated = parts.includes("generated") || /(?:^|\.)(?:generated|gen)\.[^.]+$/.test(base);
  let fileClass: FileClass;
  if (generated) fileClass = "generated";
  else if (top === "acceptance") fileClass = parts[1] === "collectors" ? "acceptance-collector" : "acceptance-pure-core";
  else if (top === "families") fileClass = "family";
  else if (top === "apps" || top === "runtime") fileClass = "production-runtime";
  else if (top === "tools" && parts[1] === "reference-only") fileClass = "reference-only";
  else if (top === "tools") fileClass = "authoring";
  else if (top === "strategies") fileClass = "strategy";
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
    output = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8" });
    flagOutput = execFileSync("git", ["ls-files", "-v", "-z"], { cwd: root, encoding: "utf8" });
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
    const metadata = classify(path);
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
        const indexedBytes = execFileSync("git", ["cat-file", "blob", blobSha], {
          cwd: root,
          encoding: null,
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
    const sourceDirectory = /^(acceptance|apps|families|packages|specs|strategies|tools|runtime)\//.test(path);
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
        if (specifier === null) report("dynamic-import-nonliteral", argument ?? node, "Dynamic import must use one literal module specifier");
        else imports.push({ specifier, offset: argument.getStart(file), dynamic: true });
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

function validateGeneratedTree(root: string, files: readonly TrackedFile[], requireReleaseTree: boolean, diagnostics: BoundaryDiagnostic[]): Set<string> {
  const generated = files.filter((file) => file.fileClass === "generated");
  const generatorPaths = validateReleaseGeneratedTree(root, files, generated, requireReleaseTree, diagnostics);
  const releaseTreeTracked = files.some((file) => file.path === RELEASE_LEDGER_PATH || file.path === "acceptance/gate-core/src/generated/release-role-manifest.ts") ||
    (files.some((file) => file.path === "acceptance/gate-core/package.json") && generated.some((file) => file.path === RELEASE_RUNTIME_PATH));
  const genericGenerated = releaseTreeTracked
    // The scheduler authority is a separately fixed fail-closed placeholder,
    // not a release-role generator output.  It is validated by the exact-null
    // check in runBoundaryGate and must not be mistaken for an unqualified
    // hand-authored generated tree.
    ? generated.filter((file) => !RELEASE_OUTPUT_PATHS.includes(file.path) && file.path !== SCHEDULER_AUTHORITY_PATH)
    : generated;
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
    return base === "index.ts" || base === "index.js" || base.endsWith("-public.ts") || path.includes("/public/");
  };
  const isPublicPluginEntry = (file: TrackedFile): boolean => (file.fileClass === "family" || file.fileClass === "strategy") && isFamilyPublic(file.path);
  const isFamilyAllowedCentralImport = (path: string): boolean => FAMILY_CENTRAL_IMPORT_ALLOWLIST.some((prefix) => path.startsWith(prefix));
  const isStrategyAllowedCentralImport = (path: string): boolean => STRATEGY_CENTRAL_IMPORT_ALLOWLIST.some((allowed) => path === allowed);
  const isCentralInternalPath = (path: string): boolean => path.includes("/src/internal/");
  const isAuthorityConstructorPath = (path: string): boolean =>
    isCentralInternalPath(path) || KNOWN_AUTHORITY_CONSTRUCTOR_PATHS.has(path) || SENSITIVE_PUBLIC_CONSTRUCTOR_PATHS.has(path);
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
    const imported = matching.flatMap(statement => {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return ["<non-exact>"];
      return clause.namedBindings.elements.map(element =>
        element.isTypeOnly || element.name.text !== (element.propertyName?.text ?? element.name.text)
          ? "<non-exact>"
          : element.name.text);
    }).sort();
    if (canonical(imported) !== canonical([...expected].sort())) {
      diagnostics.push(diagnostic("fail", "authority-named-import-mismatch", edge.from, `Authority edge must import exactly ${expected.join(", ")} from ${edge.to}`));
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
    const authorityOwnerEdge = AUTHORITY_OWNER_EDGES.has(`${edge.from}\u2192${edge.to}`);
    const authorityNamedImports = AUTHORITY_NAMED_IMPORTS.get(`${edge.from}\u2192${edge.to}`);
    if (authorityNamedImports) validateAuthorityNamedImport(edge, authorityNamedImports);
    const narrowPortImports = REVM_NARROW_PORT_IMPORTS.get(`${edge.from}\u2192${edge.to}`);
    if (narrowPortImports) validateNarrowPortImport(edge, narrowPortImports);
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
    const importsAuthorityConstructor = isAuthorityConstructorPath(to.path);
    if (testOrFixture(to.path)) diagnostics.push(diagnostic("fail", "production-imports-test-fixture", edge.from, `Non-test source imports test/fixture source ${edge.to}`));
    if (from.fileClass === "central") {
      if (to.fileClass === "family") diagnostics.push(diagnostic("fail", "central-imports-family", edge.from, `Central code imports Family source ${edge.to}`));
      if (to.fileClass === "strategy") diagnostics.push(diagnostic("fail", "central-imports-strategy", edge.from, `Central code imports Strategy source ${edge.to}`));
      if (to.fileClass === "production-runtime") diagnostics.push(diagnostic("fail", "central-imports-runtime", edge.from, `Central code imports runtime source ${edge.to}`));
      if (to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector" || to.fileClass === "reference-only") diagnostics.push(diagnostic("fail", "central-imports-governance-tool", edge.from, `Central code imports governance/acceptance source ${edge.to}`));
      if (to.fileClass === "generated") diagnostics.push(diagnostic("fail", "central-imports-generated", edge.from, `Central code cannot import generated concrete/composition output ${edge.to}`));
      if (isSpecs(from.path) && !isSpecs(to.path) && !isCanonicalCodec(to.path)) diagnostics.push(diagnostic("fail", "specs-import-outside-frozen-closure", edge.from, `Frozen specs may only import specs or canonical-codec: ${edge.to}`));
    }
    if (from.fileClass === "production-runtime") {
      if (to.fileClass === "authoring" || to.fileClass === "reference-only") diagnostics.push(diagnostic("fail", "runtime-imports-authoring", edge.from, `Runtime imports ${to.fileClass} source ${edge.to}`));
      if (to.fileClass === "family" || to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector") diagnostics.push(diagnostic("fail", "runtime-imports-family-or-acceptance", edge.from, `Runtime cannot import Family or acceptance implementation ${edge.to}`));
      if (to.fileClass === "strategy") diagnostics.push(diagnostic("fail", "runtime-imports-strategy", edge.from, `Runtime must consume generated composition, not concrete Strategy source ${edge.to}`));
      if (importsAuthorityConstructor && !authorityOwnerEdge) diagnostics.push(diagnostic("fail", "runtime-imports-authority-constructor", edge.from, `Production runtime cannot import an authority constructor directly: ${edge.to}`));
    }
    if (from.fileClass === "acceptance-pure-core" && to.fileClass !== "acceptance-pure-core" && !isSpecs(to.path) && !isCanonicalCodec(to.path) && !generatedReleaseAuthorityImport) diagnostics.push(diagnostic("fail", "acceptance-imports-production", edge.from, `Acceptance pure core may only import itself, frozen specs, canonical-codec, or the exact generated release authority: ${edge.to}`));
    if (from.fileClass === "acceptance-collector" && (to.fileClass === "production-runtime" || to.fileClass === "family" || to.fileClass === "reference-only")) diagnostics.push(diagnostic("fail", "collector-imports-production", edge.from, `Collector cannot import production or reference-only implementation ${edge.to}`));
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
    if (from.fileClass === "generated" && to.fileClass === "authoring") diagnostics.push(diagnostic("fail", "generated-imports-authoring", edge.from, `Generated output cannot import authoring code ${edge.to}`));
    if (from.fileClass === "generated" && (to.fileClass === "family" || to.fileClass === "strategy") && !(isGeneratedComposition(from.path) && isPublicPluginEntry(to))) diagnostics.push(diagnostic("fail", "generated-imports-plugin-internal", edge.from, `Only generated composition may import a Family/Strategy public entry ${edge.to}`));
    if (
      to.fileClass === "generated" &&
      from.fileClass !== "central" &&
      from.fileClass !== "generated" &&
      !productionReleaseRuntimeImport &&
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

function discoverInstalledPackageOwner(packageRoot: string, packageVersion: string): NpmLockRecordFacts | null {
  let directory = dirname(packageRoot);
  while (true) {
    const relativePackageRoot = rel(directory, packageRoot);
    if (relativePackageRoot.startsWith("node_modules/")) {
      for (const lockName of ["npm-shrinkwrap.json", "package-lock.json"] as const) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(directory, lockName), "utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          const packages = (parsed as Record<string, unknown>).packages;
          if (!packages || typeof packages !== "object" || Array.isArray(packages)) continue;
          const path = posixPath(relativePackageRoot);
          const raw = (packages as Record<string, unknown>)[path];
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const record = raw as Record<string, unknown>;
          if (record.version !== packageVersion) continue;
          return {
            path,
            version: packageVersion,
            recordHash: hashDomain("aloha/boundary/npm-lock-record/v1", { path, record }),
          };
        } catch {
          // Continue to the next exact ancestor lock candidate.
        }
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
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
  const repositoryLockPath = npmLockPathForPackage(root, packageRoot) ?? npmLockPathForPackage(physicalRoot, packageRoot);
  const externalCompilerToolchain = kind !== "npm" && packageName === "typescript";
  const repositoryLockRecord = repositoryLockPath ? npmLock.records.get(repositoryLockPath) : null;
  const installedToolchainOwner = !repositoryLockPath && externalCompilerToolchain
    ? discoverInstalledPackageOwner(packageRoot, packageVersion)
    : null;
  const lockPath = repositoryLockPath ?? (installedToolchainOwner ? `@toolchain/${installedToolchainOwner.path}` : null);
  const lockRecord = repositoryLockRecord ?? installedToolchainOwner;
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
      const forbidEnvironmentIo = sourceFileMeta.fileClass !== "authoring" && sourceFileMeta.fileClass !== "acceptance-collector" && sourceFileMeta.fileClass !== "reference-only" && !testOrFixture;
      const allowDynamicLoaders = sourceFileMeta.fileClass === "authoring" || testOrFixture;
      const scan = inspectSourceText(sourcePath, readFileSync(source.fileName, "utf8"), { pureAcceptanceCore, forbidEnvironmentIo, allowDynamicLoaders });
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

function packageNameFromLockPath(lockRecordPath: string): string | null {
  const marker = "node_modules/";
  const index = lockRecordPath.lastIndexOf(marker);
  if (index < 0) return null;
  const parts = lockRecordPath.slice(index + marker.length).split("/");
  if (!parts[0]) return null;
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
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
    const lockRecordPath = logicalPackageRoot ? npmLockPathForPackage(physicalRoot, logicalPackageRoot) : null;
    const lockRecord = lockRecordPath ? npmLock.records.get(lockRecordPath) : null;
    const packageName = lockRecordPath ? packageNameFromLockPath(lockRecordPath) : null;
    if (!lockRecordPath || !lockRecord || !lockRecord.version || !packageName) {
      diagnostics.push(diagnostic("invalid", "external-edge-owner-unproven", edge.from, `External dependency ${dependency} resolved to ${rel(physicalRoot, resolve(resolvedFileName))} but has no exact repository-relative npm lock owner (${lockRecordPath ?? "none"})`));
      continue;
    }
    const owner = {
      packageName,
      packageVersion: lockRecord.version,
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

function buildImplementationClosures(
  root: string,
  files: readonly TrackedFile[],
  contexts: readonly CompilerContext[],
  packageEntrypoints: readonly PackageEntrypoint[],
  lockFiles: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): ImplementationClosure[] {
  // A TypeScript Program owns the complete AST graph for its root set.  It is
  // therefore an entry-local observation, never a CompilerContext member or a
  // closure receipt field.  Keep only the final Program needed to derive this
  // entry's immutable inputs/edges, and drop that reference before advancing
  // to the next entry.  In particular, augmentation probes must not populate
  // a cross-entry Program cache.
  const tracked = new Map(files.map((file) => [file.path, file]));
  const repoPhysicalRoot = physicalRoot(root, diagnostics) ?? resolve(root);
  const npmLock = readNpmLockFacts(root, lockFiles, diagnostics);
  const entrypoints: ClosureEntrypoint[] = [];
  for (const context of contexts) {
    for (const path of context.rootPaths) {
      const file = tracked.get(path);
      if (file?.language !== "typescript" && file?.language !== "javascript") continue;
      entrypoints.push({ id: `compiler-root:${context.configPath}:${path}`, path, configPath: context.configPath, kind: "compiler-root", packageName: null, packageManifestPath: null });
    }
  }
  for (const entry of packageEntrypoints) {
    const matchingContexts = contexts.filter((context) => context.sourcePaths.includes(entry.path));
    if (matchingContexts.length === 0) {
      diagnostics.push(diagnostic("invalid", "package-entrypoint-not-compiler-visible", entry.manifestPath, `Public package entrypoint ${entry.subpath} is not present in a real TypeScript Program`));
      continue;
    }
    for (const context of matchingContexts) {
      entrypoints.push({
        id: `${entry.id}:${context.configPath}`,
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
  const result: ImplementationClosure[] = [];
  for (const entry of uniqueEntrypoints) {
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
      const program = ts.createProgram({ rootNames: entryRootNames, options: context.options });
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
      entrypointId: closure.entrypointId,
      closureDigest: closure.closureDigest as CatalogCompilerClosureFactV1["closureDigest"],
      programInputSetRoot: closure.programInputSetRoot as CatalogCompilerClosureFactV1["programInputSetRoot"],
    });
  });
  return sealCatalogCompilerClosureFacts(facts);
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
  if (role === "release-runtime") return manifest.releaseRuntime;
  if (predicate === undefined) throw new TypeError("predicate release binding missing");
  if (role === "predicate-adapter") return predicate;
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
  const exportDigest = role === "predicate-adapter"
    ? predicateBinding.predicateImplementationExportDigest
    : role === "qualification-oracle"
      ? predicateBinding.oracleImplementationExportDigest
      : null;
  const moduleFile = closure.files.find((file) => file.path === binding.modulePath);
  const recomputedExportDigest = exportDigest === null || exportDigest === undefined || moduleFile === undefined
    ? null
    : computeImplementationExportDigest(binding.modulePath, binding.exportName, moduleFile.contentSha256);
  if ((role === "predicate-adapter" || role === "qualification-oracle") && moduleFile === undefined) {
    diagnostics.push(diagnostic("invalid", "release-export-module-missing", binding.modulePath, `${role} module is absent from its own isolated compiler closure`));
  } else if ((role === "predicate-adapter" || role === "qualification-oracle") && (!isDigest(exportDigest) || recomputedExportDigest !== exportDigest)) {
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
    path === "acceptance/gate-core/src/predicate-contract.ts";
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
    ...manifest.predicateAdapters,
    ...manifest.predicateAdapters.map((entry) => ({
      entrypointId: entry.oracleEntrypointId,
      modulePath: entry.oracleModulePath,
      exportName: entry.oracleExportName,
    })),
    manifest.releaseRuntime,
  ];
}

function validateReleaseRoleManifestShape(
  manifest: ReleaseRoleManifestV1,
  diagnostics: BoundaryDiagnostic[],
): void {
  if (manifest.schemaVersion !== 1) diagnostics.push(diagnostic("invalid", "release-role-manifest-schema", "releaseRoleManifest.schemaVersion", "Unsupported generated release role manifest schema"));
  const refs = manifestRoleRefs(manifest);
  const ids = refs.map((ref) => ref.entrypointId);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    diagnostics.push(diagnostic("invalid", "release-role-entrypoint-unique", "releaseRoleManifest", "Release role entrypoint IDs must be non-empty and unique"));
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
  if (manifest.releaseRuntime.modulePath !== RELEASE_RUNTIME_PATH || manifest.releaseRuntime.exportName !== "evaluateGateCore") {
    diagnostics.push(diagnostic("fail", "release-runtime-binding", "releaseRoleManifest.releaseRuntime", "Release runtime is pinned to acceptance/gate-core/src/generated/release-runtime.ts#evaluateGateCore"));
  }
  for (const entry of manifest.predicateAdapters) {
    if (!entry.modulePath.startsWith("acceptance/gate-core/src/predicates/") || !/\.(?:ts|tsx|js|jsx)$/.test(entry.modulePath)) {
      diagnostics.push(diagnostic("fail", "release-predicate-binding", entry.entrypointId, "Predicate adapter module must be a concrete GateCore predicates source"));
    }
    if (!isDigest(entry.predicateSpecDigest) || !isDigest(entry.predicateProgramDescriptorDigest) || !isDigest(entry.oracleProgramDescriptorDigest) || !isDigest(entry.compositionLeafDigest) || !isDigest(entry.predicateImplementationExportDigest) || !isDigest(entry.oracleImplementationExportDigest)) {
      diagnostics.push(diagnostic("invalid", "release-bom-digest-shape", entry.entrypointId, "Predicate BOM spec, program, oracle, composition leaf, and exact export digests must be canonical hashes"));
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
  requireExactKeys(record, ["schemaVersion", "genericCore", "predicateAdapters", "releaseRuntime", "predicateCompositionRootDigest", "rootDigest"], path, diagnostics);
  const genericCore = parseReleaseRoleBinding(record.genericCore, `${path}.genericCore`, diagnostics);
  const releaseRuntime = parseReleaseRoleBinding(record.releaseRuntime, `${path}.releaseRuntime`, diagnostics);
  const rawPredicates = record.predicateAdapters;
  if (!Array.isArray(rawPredicates)) {
    diagnostics.push(diagnostic("invalid", "release-bom-predicate-type", `${path}.predicateAdapters`, "Generated predicate BOM must be an array"));
  }
  const predicateAdapters: ReleasePredicateBomEntryV1[] = [];
  for (const [index, raw] of (Array.isArray(rawPredicates) ? rawPredicates : []).entries()) {
    const binding = parseReleaseRoleBinding(raw, `${path}.predicateAdapters[${index}]`, diagnostics, false);
    const entry = asRecord(raw);
    if (binding === null || entry === null || typeof entry.predicateId !== "string" || typeof entry.predicateSpecDigest !== "string" || typeof entry.predicateProgramDescriptorDigest !== "string" || typeof entry.oracleProgramDescriptorDigest !== "string" || typeof entry.adapterVersion !== "string" || typeof entry.oracleVersion !== "string" || typeof entry.compositionLeafDigest !== "string" || typeof entry.predicateImplementationExportDigest !== "string" || typeof entry.oracleImplementationExportDigest !== "string" || typeof entry.oracleEntrypointId !== "string" || typeof entry.oracleModulePath !== "string" || typeof entry.oracleExportName !== "string") {
      diagnostics.push(diagnostic("invalid", "release-bom-predicate-shape", `${path}.predicateAdapters[${index}]`, "Predicate BOM entries require exact predicate, program, version, leaf, adapter, and oracle bindings"));
      continue;
    }
    requireExactKeys(entry, ["entrypointId", "modulePath", "exportName", "predicateId", "predicateSpecDigest", "predicateProgramDescriptorDigest", "oracleProgramDescriptorDigest", "adapterVersion", "oracleVersion", "compositionLeafDigest", "predicateImplementationExportDigest", "oracleImplementationExportDigest", "oracleEntrypointId", "oracleModulePath", "oracleExportName"], `${path}.predicateAdapters[${index}]`, diagnostics);
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
    });
  }
  if (genericCore === null || releaseRuntime === null || typeof record.predicateCompositionRootDigest !== "string" || typeof record.rootDigest !== "string") return null;
  return {
    schemaVersion: 1,
    genericCore,
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
  }
  const concreteImports = imports.flatMap((statement) => {
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) return [];
    const resolved = resolve(root, dirname(RELEASE_PREDICATE_COMPOSITION_PATH), specifier.text);
    const normalized = posixPath(relative(root, resolved));
    return normalized.startsWith("acceptance/gate-core/src/predicates/") ? [normalized] : [];
  });
  const expectedConcreteImports = manifest.predicateAdapters.map((entry) => entry.modulePath).sort();
  if (canonical([...new Set(concreteImports)].sort()) !== canonical(expectedConcreteImports)) {
    diagnostics.push(diagnostic("fail", "release-bom-generated-concrete-import-set", RELEASE_PREDICATE_COMPOSITION_PATH, "Generated BOM concrete adapter imports must exactly equal the manifest leaves"));
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
      const exactMetadata = ts.isObjectLiteralExpression(frozenObject) &&
        staticStringProperty(frozenObject, "predicateId") === entry.predicateId &&
        staticStringProperty(frozenObject, "predicateSpecDigest") === entry.predicateSpecDigest &&
        staticStringProperty(frozenObject, "predicateProgramDescriptorDigest") === entry.predicateProgramDescriptorDigest &&
        staticStringProperty(frozenObject, "oracleProgramDescriptorDigest") === entry.oracleProgramDescriptorDigest &&
        staticStringProperty(frozenObject, "adapterVersion") === entry.adapterVersion &&
        staticStringProperty(frozenObject, "oracleVersion") === entry.oracleVersion &&
        staticStringProperty(frozenObject, "compositionLeafDigest") === entry.compositionLeafDigest &&
        staticStringProperty(frozenObject, "predicateImplementationExportDigest") === entry.predicateImplementationExportDigest &&
        staticStringProperty(frozenObject, "oracleImplementationExportDigest") === entry.oracleImplementationExportDigest;
      if (!exactMetadata || !ts.isObjectLiteralExpression(frozenObject) || staticIdentifierProperty(frozenObject, "evaluator") !== expectedAliases[index]) {
        diagnostics.push(diagnostic("fail", "release-bom-generated-evaluator-identity", RELEASE_PREDICATE_COMPOSITION_PATH, `Generated BOM binding ${index} must carry the exact imported evaluator identity`));
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
  for (const [specifier, importedName] of [
    ["../index.ts", "createReleaseAuthorityUnavailableResult"],
    ["../index.ts", "evaluateGateCoreRuntime"],
    ["./predicate-composition.ts", "PREDICATE_COMPOSITION_ROOT_DIGEST"],
    ["./predicate-composition.ts", "resolvePredicateEvaluator"],
    ["./release-authority.ts", "RELEASE_AUTHORITY"],
  ] as const) {
    if (!hasExactNamedImport(sourceFile, specifier, importedName)) {
      diagnostics.push(diagnostic("fail", "release-runtime-binding-import", RELEASE_RUNTIME_PATH, `Public wrapper must use exact named import ${specifier}#${importedName}`));
    }
  }

  const composition = sourceVariableDeclaration(sourceFile, "RELEASE_COMPOSITION");
  const rootDigest = composition?.initializer === undefined ? null : staticEvaluatorProperty(composition.initializer, "rootDigest");
  const resolver = composition?.initializer === undefined ? null : staticEvaluatorProperty(composition.initializer, "resolve");
  if (!rootDigest || !ts.isIdentifier(rootDigest) || rootDigest.text !== "PREDICATE_COMPOSITION_ROOT_DIGEST" || !resolver || !ts.isIdentifier(resolver) || resolver.text !== "resolvePredicateEvaluator") {
    diagnostics.push(diagnostic("fail", "release-runtime-composition-binding", RELEASE_RUNTIME_PATH, "Public wrapper must bind the exact generated composition root and resolver"));
  }

  const wrappers = sourceFile.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "evaluateGateCore" && Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)));
  const wrapper = wrappers.length === 1 ? wrappers[0]! : null;
  if (wrapper === null || wrapper.parameters.length !== 1 || !ts.isIdentifier(wrapper.parameters[0]!.name) || wrapper.body === undefined || wrapper.body.statements.length !== 3) {
    diagnostics.push(diagnostic("fail", "release-runtime-public-wrapper", RELEASE_RUNTIME_PATH, "Release runtime must expose one exact single-argument fail-closed strict wrapper"));
    return;
  }
  const parameterName = wrapper.parameters[0]!.name.text;
  const [guard, clock, finalReturn] = wrapper.body.statements;
  const guardValid = ts.isIfStatement(guard!) && guard!.elseStatement === undefined &&
    ts.isBinaryExpression(guard!.expression) && guard!.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isIdentifier(guard!.expression.left) && guard!.expression.left.text === "RELEASE_AUTHORITY" && guard!.expression.right.kind === ts.SyntaxKind.NullKeyword &&
    ts.isReturnStatement(guard!.thenStatement) && guard!.thenStatement.expression !== undefined && ts.isCallExpression(guard!.thenStatement.expression) &&
    ts.isIdentifier(guard!.thenStatement.expression.expression) && guard!.thenStatement.expression.expression.text === "createReleaseAuthorityUnavailableResult" && guard!.thenStatement.expression.arguments.length === 0;
  if (!guardValid) diagnostics.push(diagnostic("fail", "release-runtime-null-authority-guard", RELEASE_RUNTIME_PATH, "Public wrapper must return unavailable before inspecting input when generated authority is null"));

  let clockName: string | null = null;
  let clockValid = false;
  if (ts.isVariableStatement(clock!) && (clock!.declarationList.flags & ts.NodeFlags.Const) !== 0 && clock!.declarationList.declarations.length === 1) {
    const declaration = clock!.declarationList.declarations[0]!;
    if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
      clockName = declaration.name.text;
      const rendered = declaration.initializer.getText(sourceFile).replace(/\s|_/g, "");
      clockValid = rendered === "(BigInt(Date.now())*1000000n).toString()";
    }
  }
  if (!clockValid) diagnostics.push(diagnostic("fail", "release-runtime-clock-binding", RELEASE_RUNTIME_PATH, "Public wrapper clock must be the exact current wall-clock nanosecond conversion"));

  const strictCall = ts.isReturnStatement(finalReturn!) && finalReturn!.expression !== undefined && ts.isCallExpression(finalReturn!.expression)
    ? finalReturn!.expression
    : null;
  const strictCallValid = strictCall !== null && ts.isIdentifier(strictCall.expression) && strictCall.expression.text === "evaluateGateCoreRuntime" && strictCall.arguments.length === 4 &&
    ts.isIdentifier(strictCall.arguments[0]!) && strictCall.arguments[0]!.text === "RELEASE_AUTHORITY" &&
    ts.isIdentifier(strictCall.arguments[1]!) && strictCall.arguments[1]!.text === parameterName &&
    ts.isIdentifier(strictCall.arguments[2]!) && strictCall.arguments[2]!.text === "RELEASE_COMPOSITION" &&
    clockName !== null && ts.isIdentifier(strictCall.arguments[3]!) && strictCall.arguments[3]!.text === clockName;
  if (!strictCallValid) diagnostics.push(diagnostic("fail", "release-runtime-strict-call", RELEASE_RUNTIME_PATH, "Public wrapper must return the strict GateCore result with generated authority, composition, input, and current clock"));
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
  "RuntimeReleaseReadyInputV1",
  "RuntimeReleaseCompositionInputV1",
  "RuntimeReleaseCompositionServicesV1",
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
      const ownerName = owner && ts.isFunctionDeclaration(owner) ? owner.name?.text : null;
      if (ownerName !== "composeRuntimeReleasePrivatePorts") {
        diagnostics.push(diagnostic("fail", "runtime-release-private-join-bypass", RUNTIME_RELEASE_BOOTSTRAP_PATH, `Runtime release owner ${node.expression.text} must be called only by composeRuntimeReleasePrivatePorts`, node.expression.getStart(sourceFile)));
      }
    }
    ts.forEachChild(node, visitJoins);
  };
  visitJoins(sourceFile);
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
    const predicatePaths = new Set(manifest.predicateAdapters.map((entry) => entry.modulePath));
    for (const statement of compositionFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const targetPath = localSourceImportTargets(root, RELEASE_COMPOSITION_PATH, statement.moduleSpecifier.text).find((candidate) => predicatePaths.has(candidate));
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
  const predicateAdapters = manifest.predicateAdapters
    .map((entry) => releaseClosureRoleRef(receipt, "predicate-adapter", releaseBindingForRole("predicate-adapter", manifest, entry), diagnostics))
    .filter((value): value is ReleaseClosureRefV1 => value !== null);
  const qualificationOracles = manifest.predicateAdapters
    .map((entry) => releaseClosureRoleRef(receipt, "qualification-oracle", releaseBindingForRole("qualification-oracle", manifest, entry), diagnostics))
    .filter((value): value is ReleaseClosureRefV1 => value !== null);
  const releaseRuntime = releaseClosureRoleRef(receipt, "release-runtime", releaseBindingForRole("release-runtime", manifest), diagnostics);
  if (genericCore === null || releaseRuntime === null || predicateAdapters.length !== manifest.predicateAdapters.length || qualificationOracles.length !== manifest.predicateAdapters.length || diagnostics.length > 0) {
    return { facts: null, diagnostics: uniqueDiagnostics(diagnostics) };
  }
  validateProductionReleaseClosure(receipt, releaseRuntime, diagnostics);
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
  for (const adapter of predicateAdapters) {
    assertReleaseClosureExcludesEntrypoint(receipt, genericCore, adapter, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, adapter, releaseRuntime, diagnostics);
  }
  for (const oracle of qualificationOracles) {
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, genericCore, diagnostics);
    assertReleaseClosureExcludesEntrypoint(receipt, oracle, releaseRuntime, diagnostics);
  }
  assertReleaseClosureContains(receipt, releaseRuntime, genericCore, diagnostics);
  for (const adapter of predicateAdapters) assertReleaseClosureContains(receipt, releaseRuntime, adapter, diagnostics);
  if (diagnostics.length > 0) return { facts: null, diagnostics: uniqueDiagnostics(diagnostics) };
  const base = Object.freeze({
    schemaVersion: 1 as const,
    genericCore,
    predicateAdapters: Object.freeze(predicateAdapters),
    qualificationOracles: Object.freeze(qualificationOracles),
    releaseRuntime,
    predicateCompositionRootDigest: manifest.predicateCompositionRootDigest,
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
  if (facts.schemaVersion !== 1) diagnostics.push(diagnostic("invalid", "release-closure-schema", "releaseClosures.schemaVersion", "Unsupported release closure facts schema"));
  const refs = [facts.genericCore, ...facts.predicateAdapters, ...facts.qualificationOracles, facts.releaseRuntime];
  if (new Set(refs.map((ref) => ref.entrypointId)).size !== refs.length) diagnostics.push(diagnostic("invalid", "release-closure-role-alias", "releaseClosures", "Stored release roles alias one compiler closure"));
  const predicateBindingKey = (ref: ReleaseClosureRefV1): string => canonical({
    predicateId: ref.predicateId,
    predicateSpecDigest: ref.predicateSpecDigest,
    predicateProgramDescriptorDigest: ref.predicateProgramDescriptorDigest,
    oracleProgramDescriptorDigest: ref.oracleProgramDescriptorDigest,
    adapterVersion: ref.adapterVersion,
    oracleVersion: ref.oracleVersion,
    compositionLeafDigest: ref.compositionLeafDigest,
  });
  if (facts.predicateAdapters.length !== facts.qualificationOracles.length || facts.predicateAdapters.some((adapter, index) => predicateBindingKey(adapter) !== predicateBindingKey(facts.qualificationOracles[index]!))) {
    diagnostics.push(diagnostic("invalid", "release-predicate-oracle-binding-mismatch", "releaseClosures", "Each predicate adapter must be paired with one oracle carrying the same exact predicate identity and descriptors"));
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
    if (actual.entrypoint !== ref.entrypoint || actual.modulePath !== ref.modulePath || actual.exportName !== ref.exportName || actual.predicateId !== ref.predicateId || actual.predicateSpecDigest !== ref.predicateSpecDigest || actual.predicateProgramDescriptorDigest !== ref.predicateProgramDescriptorDigest || actual.oracleProgramDescriptorDigest !== ref.oracleProgramDescriptorDigest || actual.adapterVersion !== ref.adapterVersion || actual.oracleVersion !== ref.oracleVersion || actual.compositionLeafDigest !== ref.compositionLeafDigest || actual.implementationExportDigest !== ref.implementationExportDigest || actual.closureDigest !== ref.closureDigest || actual.programInputSetRoot !== ref.programInputSetRoot) {
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
  validateProductionReleaseClosure(receipt, facts.releaseRuntime, diagnostics);
  const base = {
    schemaVersion: 1 as const,
    genericCore: facts.genericCore,
    predicateAdapters: facts.predicateAdapters,
    qualificationOracles: facts.qualificationOracles,
    releaseRuntime: facts.releaseRuntime,
    predicateCompositionRootDigest: facts.predicateCompositionRootDigest,
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
  if (receipt.schemaVersion !== 1 || receipt.gate !== "aloha.machine-enforced-boundary" || receipt.claims.productionAuthority !== "not-observed") return null;
  if (receipt.verdict !== "pass" || !receipt.candidate.clean || receipt.diagnostics.length !== 0) return null;
  if (policy.mode !== "collector" && !receipt.candidate.pushed) return null;
  const closure = findImplementationClosureById(receipt, entrypointId);
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
  if (receipt.schemaVersion !== 1 || receipt.gate !== "aloha.machine-enforced-boundary" || receipt.claims.productionAuthority !== "not-observed") return null;
  if (receipt.verdict !== "pass" || !receipt.candidate.clean || receipt.diagnostics.length !== 0) return null;
  if (policy.mode !== "collector" && !receipt.candidate.pushed) return null;
  const closure = findImplementationClosureById(receipt, entrypointId);
  if (!closure || computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot || recomputeImplementationClosureDigest(closure) !== closure.closureDigest) return null;
  return closure.closureDigest;
}

function exactGitState(root: string, requirePushed: boolean, diagnostics: BoundaryDiagnostic[]): BoundaryReceipt["candidate"] {
  let branch: string | null = null;
  let headSha: string | null = null;
  let upstreamSha: string | null = null;
  let clean = false;
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("not a Git work tree");
    branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]) || null;
    headSha = git(root, ["rev-parse", "HEAD"]) || null;
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
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
    if (requirePushed && !upstreamSha) diagnostics.push(diagnostic("invalid", "unpushed-candidate", ".", "No upstream ref proves this candidate was pushed"));
    if (requirePushed && upstreamSha && headSha !== upstreamSha) diagnostics.push(diagnostic("invalid", "remote-not-at-head", ".", "HEAD is not the exact upstream tip"));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "git-state-unreadable", ".", String(error)));
  }
  return { gitRoot: root, branch, headSha, upstreamSha, clean, pushed: Boolean(headSha && upstreamSha && headSha === upstreamSha) };
}

function languageAdapterCheck(files: readonly TrackedFile[], diagnostics: BoundaryDiagnostic[]): void {
  const rust = files.some((file) => file.language === "rust");
  const solidity = files.some((file) => file.language === "solidity");
  if (rust) diagnostics.push(diagnostic("invalid", "rust-build-adapter-missing", ".", "A .rs file entered the denominator without a pinned cargo/build-graph adapter"));
  if (solidity) diagnostics.push(diagnostic("invalid", "solidity-build-adapter-missing", ".", "A .sol file entered the denominator without a pinned solc/Forge build-graph adapter"));
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
  const packageData = readPackageManifests(root, files, diagnostics);
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
  languageAdapterCheck(files, diagnostics);
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
    externalDependencies: graph.externalDependencies,
    workspaceNames: packageData.workspaceNames,
  };
  const finalDiagnostics = uniqueDiagnostics(diagnostics);
  const verdict = finalDiagnostics.some((item) => item.kind === "invalid") ? "invalid" : finalDiagnostics.length > 0 ? "fail" : "pass";
  return {
    schemaVersion: 1,
    gate: "aloha.machine-enforced-boundary",
    verdict,
    candidate,
    denominator: { scannedFileSetRoot, manifestRoot, files },
    compiler,
    graph: { nodes: graph.nodes, edges: graph.edges },
    implementationClosures,
    releaseRoleManifest,
    releaseClosures: releaseClosureDerivation.facts,
    diagnostics: finalDiagnostics,
    mutationCorpus: { root: hashDomain("aloha/boundary/mutation-corpus/v1", mutationCorpus), cases: mutationCorpus },
    claims: { sourceBuildClosure: "observed", runtimeLegacyZero: "not-asserted", productionAuthority: "not-observed" },
  };
}

export function formatReceipt(receipt: BoundaryReceipt): string {
  return `${canonical(receipt)}\n`;
}
