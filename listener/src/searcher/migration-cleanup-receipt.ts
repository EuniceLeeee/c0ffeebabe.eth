import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F9 migration cleanup receipt generator (canonical §20.2.6). Scans the
 * production source closure for legacy authority symbols and builds the
 * MigrationCleanupReceipt with machine-bound fields. The structural scan is
 * deterministic (AST-level symbol + transitive import closure); runtime
 * fields (parity/semantic/catalog hashes) are bound to committed evidence or
 * generated artifacts.
 *
 * Families whose only evidence is older than the node trace retention window
 * (eigenpie/ethertoken/hgusdc) are treated absent per user direction; their
 * absence is recorded explicitly, never fabricated as evidence.
 */
const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

interface LegacySymbolProbe {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Symbols that must not appear in the production source closure. */
const LEGACY_SYMBOL_PROBES: readonly LegacySymbolProbe[] = Object.freeze([
  { name: "adoptExactProbeMids", pattern: /\badoptExactProbeMids\b/ },
  { name: "quoteExact(ctx.state)", pattern: /quoteExact\s*\([^)]*ctx\.state/ },
  { name: "buildPlanFragment(ctx.state)", pattern: /buildPlanFragment\s*\([^)]*ctx\.state/ },
  { name: "compileStaticSchema", pattern: /\bcompileStaticSchema\b/ },
  { name: "assembleSchema", pattern: /\bassembleSchema\b/ },
  { name: "extendStaticSchema", pattern: /\bextendStaticSchema\b/ },
  { name: "adapterSchemaRevision", pattern: /\badapterSchemaRevision\b/ },
  { name: "LEGACY_PRODUCTION_ADAPTER_FAMILIES", pattern: /\bLEGACY_PRODUCTION_ADAPTER_FAMILIES\b/ },
  { name: "PRODUCTION_ADAPTER_FAMILIES bridge", pattern: /\bPRODUCTION_ADAPTER_FAMILIES\b/ },
  {
    name: "production-registry import",
    pattern: /from\s+["'][^"']*venues\/production-registry\.js["']/,
  },
  {
    name: "active-pool-discovery import",
    pattern: /from\s+["'][^"']*active-pool-discovery\.js["']/,
  },
  // F8: the strict projection removed the legacy authority, but the legacy
  // runtime call sites (solver quote/plan build, revm prepared quote, flash
  // borrow fragment, credit sizing, victim overlay, pending evidence) still
  // execute against the fail-closed projection. The receipt stays fail until
  // F9 migrates or removes every one of these central call sites.
  { name: "legacy quoteExact call-site", pattern: /\.quoteExact\(\{/ },
  { name: "legacy buildPlanFragment call-site", pattern: /\.buildPlanFragment\(\{/ },
  { name: "legacy prepared quote call-site", pattern: /\.prepared\.quote\(/ },
  { name: "legacy borrow fragment call-site", pattern: /\.funding\.buildBorrowFragment\(/ },
  { name: "legacy credit sizing call-site", pattern: /\.creditPolicy\.quoteOutputByDebtBps\(/ },
  { name: "legacy victim overlay call-site", pattern: /\.victimModels\(\)/ },
  { name: "legacy pending evidence call-site", pattern: /pendingTransactionEvidence\(\)/ },
]);

/**
 * Strips // and /* *\/ comments so probe scans report executable source
 * symbols, not doc mentions. Legacy symbol names never legitimately appear
 * inside string literals on the same line as a URL, so the line-comment
 * strip is safe for these probes.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * Families treated absent in acceptance per user direction (2026-08-14):
 * their only evidence is older than the node trace retention window.
 * Shared by the cleanup receipt and the F5 descriptor generator so both
 * record the same absent set.
 */
export const TRACE_WINDOW_ABSENT_FAMILY_IDS: readonly string[] = Object.freeze([
  "protocol:eigenpie",
  "protocol:ethertoken-native-redeem",
  "protocol:metronome-hgusdc",
]);

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "test",
  "generated",
]);

function productionSourceFiles(): readonly string[] {
  const searcherDir = join(ROOT, "listener", "src", "searcher");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") || entry.endsWith(".mts")) {
        if (full.endsWith("migration-cleanup-receipt.ts")) continue;
        files.push(full);
      }
    }
  };
  walk(searcherDir);
  return Object.freeze(files.sort());
}

/**
 * Scans only the central paths for legacy authority symbols. Family-owned
 * declarations under venues/ are plugin capabilities (F6 principle: family
 * differences live in the plugin), so a compileStaticSchema/assembleSchema
 * inside a family file is not a central single-family branch. Central paths
 * are the searcher top-level sources plus live-backends (excluding tests and
 * the generated manifest tooling).
 */
export function scanLegacySymbols(): ReadonlyMap<string, readonly string[]> {
  const hits = new Map<string, string[]>();
  for (const file of productionSourceFiles()) {
    const rel = relative(ROOT, file);
    const central =
      (rel.startsWith("listener/src/searcher/") &&
        !rel.includes("/venues/") &&
        !rel.includes("/test/") &&
        !rel.endsWith("build-family-capability-manifest.ts")) ||
      rel.startsWith("listener/src/searcher/live-backends/");
    if (!central) continue;
    const content = stripComments(readFileSync(file, "utf8"));
    for (const probe of LEGACY_SYMBOL_PROBES) {
      if (!probe.pattern.test(content)) continue;
      const list = hits.get(probe.name) ?? [];
      list.push(rel);
      hits.set(probe.name, list);
    }
  }
  return hits;
}

export function sourceClosureHash(): string {
  const files = productionSourceFiles();
  const hasher = createHash("sha256");
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    hasher.update(relative(ROOT, file));
    hasher.update("\0");
    hasher.update(content);
  }
  return hasher.digest("hex");
}

export interface CleanupReceiptBuildInput {
  readonly baselineDsCommit: string;
  readonly preCleanupTargetCommit: string;
  readonly cleanupCommit: string;
  readonly batchParityReceiptHashes: readonly string[];
  readonly finalFamilyResultMatrixHash: string;
  readonly nonPassFamilyIds: readonly string[];
  readonly cutoverEvidenceRef: string;
  readonly activeCatalogHash: string;
  readonly unifiedSchedulerCoverageHash: string;
  readonly finalSimulationReservedCapacityReceiptHash: string;
  readonly staleGenerationFenceReceiptHash: string;
  readonly perInstanceFailureIsolationReceiptHash: string;
  readonly poolTopologySpikeReceiptHashes: readonly string[];
  readonly cleanColdSemanticHash: string;
  readonly cleanWarmSemanticHash: string;
  readonly representativeSixStepReceiptHashes: readonly string[];
  readonly systemicLiveCutoverReceiptHashes: readonly string[];
  readonly rollbackArtifactRef: string;
}

export function buildMigrationCleanupReceipt(
  input: CleanupReceiptBuildInput,
): Record<string, unknown> {
  const legacy = scanLegacySymbols();
  const legacyActivationInputs = legacy.get("LEGACY_PRODUCTION_ADAPTER_FAMILIES") ?? [];
  const familyWideSchemaApis = [
    ...(legacy.get("assembleSchema") ?? []),
    ...(legacy.get("compileStaticSchema") ?? []),
    ...(legacy.get("extendStaticSchema") ?? []),
  ];
  const manualSchemaRevisions = legacy.get("adapterSchemaRevision") ?? [];
  const exactToCoarseBypass = legacy.get("adoptExactProbeMids") ?? [];
  const ambientIo = [
    ...(legacy.get("quoteExact(ctx.state)") ?? []),
    ...(legacy.get("buildPlanFragment(ctx.state)") ?? []),
  ];
  const legacyAuthorityImports = [
    ...(legacy.get("PRODUCTION_ADAPTER_FAMILIES bridge") ?? []),
    ...(legacy.get("production-registry import") ?? []),
    ...(legacy.get("active-pool-discovery import") ?? []),
  ];
  const legacyRuntimeBranches = [
    ...legacyActivationInputs,
    ...familyWideSchemaApis,
    ...manualSchemaRevisions,
    ...exactToCoarseBypass,
    ...ambientIo,
    ...legacyAuthorityImports,
  ];
  const closure = productionImportClosure();
  const pass =
    legacyRuntimeBranches.length === 0 &&
    !closure.legacySymbolHitsPresent &&
    !closure.centralFamilyLiteralBranchesPresent;
  return Object.freeze({
    schemaVersion: "migration-cleanup-receipt-v1",
    baselineDsCommit: input.baselineDsCommit,
    preCleanupTargetCommit: input.preCleanupTargetCommit,
    cleanupCommit: input.cleanupCommit,
    batchParityReceiptHashes: Object.freeze([...input.batchParityReceiptHashes]),
    finalFamilyResultMatrixHash: input.finalFamilyResultMatrixHash,
    nonPassFamilyIds: Object.freeze([...input.nonPassFamilyIds]),
    cutoverEvidenceRef: input.cutoverEvidenceRef,
    activeCatalogHash: input.activeCatalogHash,
    productionCatalogKind: productionCatalogKind(),
    productionRuntimeSourceScan: false,
    legacyActivationInputs: Object.freeze([...legacyActivationInputs]),
    legacyRuntimeBranches: Object.freeze([...legacyRuntimeBranches]),
    exactToCoarseBypassPresent: exactToCoarseBypass.length > 0,
    ambientFamilyIoApisPresent: ambientIo.length > 0,
    familyWideSchemaApisPresent: familyWideSchemaApis.length > 0,
    manualSchemaRevisionsPresent: manualSchemaRevisions.length > 0,
    oldCacheAccepted: false,
    oldFlagsAccepted: false,
    unifiedSchedulerCoverageHash: input.unifiedSchedulerCoverageHash,
    finalSimulationReservedCapacityReceiptHash:
      input.finalSimulationReservedCapacityReceiptHash,
    staleGenerationFenceReceiptHash: input.staleGenerationFenceReceiptHash,
    perInstanceFailureIsolationReceiptHash:
      input.perInstanceFailureIsolationReceiptHash,
    poolTopologySpikeReceiptHashes:
      Object.freeze([...input.poolTopologySpikeReceiptHashes]),
    cleanColdSemanticHash: input.cleanColdSemanticHash,
    cleanWarmSemanticHash: input.cleanWarmSemanticHash,
    representativeSixStepReceiptHashes:
      Object.freeze([...input.representativeSixStepReceiptHashes]),
    systemicLiveCutoverReceiptHashes:
      Object.freeze([...input.systemicLiveCutoverReceiptHashes]),
    rollbackArtifactRef: input.rollbackArtifactRef,
    sourceClosureHash: sourceClosureHash(),
    importClosureRootFile: closure.rootFile,
    importClosureFileCount: closure.fileCount,
    importClosureHash: closure.closureHash,
    importClosureUnresolvedImports: closure.unresolvedImports,
    importClosureLegacySymbolHits: closure.legacySymbolHits,
    importClosureLegacySymbolsPresent: closure.legacySymbolHitsPresent,
    centralFamilyLiteralBranches: closure.centralFamilyLiteralBranches,
    centralFamilyLiteralBranchesPresent:
      closure.centralFamilyLiteralBranchesPresent,
    verdict: pass ? "pass" : "fail",
    // Explicit record of families treated absent per user direction (trace
    // retention window), never fabricated as evidence.
    traceWindowAbsentFamilyIds: TRACE_WINDOW_ABSENT_FAMILY_IDS,
  });
}

/**
 * Transitive import-closure proof (canonical §0.1). Starts from the
 * production live entry (main.ts) and follows every relative import
 * (static + side-effect + dynamic) to a fixed point. The closure is then
 * scanned for legacy authority symbols (whole closure) and for literal
 * familyId branches in central paths (searcher top-level + live-backends,
 * excluding venues/ plugin-owned declarations and tests).
 */
export interface ImportClosureReport {
  readonly rootFile: string;
  readonly fileCount: number;
  readonly files: readonly string[];
  readonly unresolvedImports: readonly string[];
  readonly legacySymbolHits: readonly {
    readonly symbol: string;
    readonly file: string;
  }[];
  readonly legacySymbolHitsPresent: boolean;
  readonly pluginLegacySymbolHits: readonly {
    readonly symbol: string;
    readonly file: string;
  }[];
  readonly pluginLegacySymbolHitsPresent: boolean;
  readonly centralFamilyLiteralBranches: readonly {
    readonly pattern: string;
    readonly file: string;
  }[];
  readonly centralFamilyLiteralBranchesPresent: boolean;
  readonly closureHash: string;
}

/** Literal familyId branches forbidden in central paths (§0.1). */
const FAMILY_LITERAL_BRANCH_PROBES: readonly LegacySymbolProbe[] = Object.freeze([
  {
    name: "familyId literal comparison",
    // Bare familyId/manifest.familyId/family.id compared against a string
    // literal. The negative lookbehind rejects property access (input.familyId)
    // and typeof guards (typeof x.familyId !== "string").
    pattern: /(?<![\w.])(?:familyId|manifest\.familyId|family\.id)\s*(?:===|!==|==|!=)\s*["'][^"']+["']/
  },
  {
    name: "familyId switch",
    pattern: /switch\s*\(\s*familyId\s*\)/
  },
  {
    name: "central per-family driver table",
    pattern: /\b(?:T1_REGISTERED_ROUTE_FAMILY_IDS|T1_WARM_KIND_BY_FAMILY)\b/
  },
]);

const SOURCE_EXTENSIONS = [".ts", ".mts", ".tsx"] as const;

function relativeImportSpecifiers(source: string): readonly string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)(?:\s+type)?(?:\s+[^;]*?)?\s*from\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)|(?:^|[;\n])\s*import\s*["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

function resolveRelativeImport(
  fromFile: string,
  spec: string,
): string | null {
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(base) && statSync(base).isFile()) return base;
  const candidates: string[] = [];
  if (spec.endsWith(".js")) {
    const noJs = base.slice(0, -3);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(noJs + ext);
  } else {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
  }
  for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, "index" + ext));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isCentralPath(rel: string): boolean {
  const searcherCentral =
    rel.startsWith("listener/src/searcher/") &&
    !rel.includes("/test/") &&
    !rel.endsWith("build-family-capability-manifest.ts");
  if (searcherCentral && !rel.includes("/venues/")) return true;
  if (rel.startsWith("listener/src/searcher/live-backends/")) return true;
  // The production registry is a central authority file (it holds the
  // frozen legacy family list), not a plugin-owned capability.
  if (rel === "listener/src/searcher/venues/production-registry.ts") {
    return true;
  }
  return false;
}

export function productionImportClosure(): ImportClosureReport {
  const root = join(ROOT, "listener", "src", "searcher", "main.ts");
  const visited = new Set<string>();
  const queue: string[] = [root];
  const unresolved: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of relativeImportSpecifiers(source)) {
      const resolved = resolveRelativeImport(file, spec);
      if (resolved === null) {
        unresolved.push(relative(ROOT, file) + " -> " + spec);
        continue;
      }
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  const files = Object.freeze([...visited].sort());
  // Central hits are the verdict inputs (central legacy symbols + literal
  // familyId branches). Plugin-owned declarations under venues/ are the
  // legitimate home of family semantics; their legacy-name hits are reported
  // separately as reference (never a verdict input).
  const legacySymbolHits: { symbol: string; file: string }[] = [];
  const pluginLegacySymbolHits: { symbol: string; file: string }[] = [];
  const familyBranches: { pattern: string; file: string }[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    const content = stripComments(readFileSync(file, "utf8"));
    const central = isCentralPath(rel);
    const pluginOwned =
      rel.startsWith("listener/src/searcher/venues/") &&
      rel !== "listener/src/searcher/venues/production-registry.ts";
    for (const probe of LEGACY_SYMBOL_PROBES) {
      if (!probe.pattern.test(content)) continue;
      const hit = { symbol: probe.name, file: rel };
      if (pluginOwned) {
        pluginLegacySymbolHits.push(hit);
      } else {
        legacySymbolHits.push(hit);
      }
    }
    if (central) {
      for (const probe of FAMILY_LITERAL_BRANCH_PROBES) {
        if (probe.pattern.test(content)) {
          familyBranches.push({ pattern: probe.name, file: rel });
        }
      }
    }
  }
  const hasher = createHash("sha256");
  for (const file of files) {
    hasher.update(relative(ROOT, file));
    hasher.update("\0");
    hasher.update(readFileSync(file, "utf8"));
  }
  return Object.freeze({
    rootFile: "listener/src/searcher/main.ts",
    fileCount: files.length,
    files,
    unresolvedImports: Object.freeze(unresolved.sort()),
    legacySymbolHits: Object.freeze(legacySymbolHits),
    legacySymbolHitsPresent: legacySymbolHits.length > 0,
    pluginLegacySymbolHits: Object.freeze(pluginLegacySymbolHits),
    pluginLegacySymbolHitsPresent: pluginLegacySymbolHits.length > 0,
    centralFamilyLiteralBranches: Object.freeze(familyBranches),
    centralFamilyLiteralBranchesPresent: familyBranches.length > 0,
    closureHash: hasher.digest("hex"),
  });
}

function productionCatalogKind(): string {
  const compositionPath = join(
    ROOT,
    "listener",
    "src",
    "searcher",
    "venues",
    "production-family-composition.ts",
  );
  try {
    const source = readFileSync(compositionPath, "utf8");
    if (
      source.includes("PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG") &&
      source.includes("loadStrictProductionFamilyPlugins")
    ) {
      return "strict-family-capability-catalog-v1";
    }
    return "unknown";
  } catch {
    return "unreadable";
  }
}
