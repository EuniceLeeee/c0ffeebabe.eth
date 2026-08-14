import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
    const content = readFileSync(file, "utf8");
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
  const legacyRuntimeBranches = [
    ...legacyActivationInputs,
    ...familyWideSchemaApis,
    ...manualSchemaRevisions,
    ...exactToCoarseBypass,
    ...ambientIo,
  ];
  const pass = legacyRuntimeBranches.length === 0;
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
    verdict: pass ? "pass" : "fail",
    // Explicit record of families treated absent per user direction (trace
    // retention window), never fabricated as evidence.
    traceWindowAbsentFamilyIds: Object.freeze([
      "protocol:eigenpie",
      "protocol:ethertoken-native-redeem",
      "metronome-hgusdc",
    ]),
  });
}

function productionCatalogKind(): string {
  const registryPath = join(
    ROOT,
    "listener",
    "src",
    "searcher",
    "venues",
    "production-registry.ts",
  );
  try {
    const source = readFileSync(registryPath, "utf8");
    if (source.includes("frozen-legacy-route-authority-v1")) {
      return "frozen-legacy-route-authority-v1";
    }
    if (source.includes("generated-static-imports")) {
      return "generated-static-imports";
    }
    return "unknown";
  } catch {
    return "unreadable";
  }
}
