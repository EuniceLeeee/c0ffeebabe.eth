import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "./content-addressed-sink.ts";
import {
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "./internal/release-owned-observer-store.ts";
import { observeProductionClosureRawFactsV1 } from "./production-closure-observer.ts";
import { observeRuntimeAcceptanceProcessDatabaseV1 } from "./raw-runtime-acceptance-observer.ts";
import { observeProductionPerformanceDatabaseV1 } from "../../../packages/performance-collector/src/raw-sqlite-observer.ts";
import { observeProductionRuntimeRestartFactsV1 } from "./runtime-restart-facts-observer.ts";
import {
  readQualifiedReleaseLineageObservationV1,
  type QualifiedReleaseAcceptanceRunnerCapabilityV1,
} from "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../specs/release-authority/src/index.ts";
import {
  readPreReleaseAdvisoryMaterialCapabilityV1,
  type PreReleaseAdvisoryMaterialCapabilityV1,
} from "../../../tools/runtime-release-packager/src/pre-release-staging.ts";
import {
  issueProductionLegacyAuthorityMaterialObserverOwnerPortV1,
  issueProductionRuntimeRestartMaterialObserverOwnerPortV1,
  issueProductionSourceClosureMaterialObserverOwnerPortV1,
  productionRuntimeBoundaryMaterialEvidenceRootV1,
  type ProductionLegacyAuthorityMaterialObserverPortV1,
  type ProductionRuntimeBoundaryMaterialObservationV1,
  type ProductionRuntimeRestartMaterialObserverPortV1,
  type ProductionSourceClosureMaterialObserverPortV1,
} from "./internal/runtime-boundary-material-owner.ts";

function absolutePath(value: string, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) throw new TypeError(`${label} must be absolute`);
  return resolve(value);
}

function missing(kind: string, reasons: readonly string[], evidence: unknown): ProductionRuntimeBoundaryMaterialObservationV1 {
  return Object.freeze({
    status: "missing" as const,
    reasons: Object.freeze([...reasons]),
    evidenceRoot: hashDomain("aloha/production-runtime-boundary-material-missing/v1", { kind, reasons, evidence }),
  });
}

function invalid(kind: string, reasons: readonly string[], evidence: unknown): ProductionRuntimeBoundaryMaterialObservationV1 {
  return Object.freeze({
    status: "invalid" as const,
    reasons: Object.freeze([...reasons]),
    evidenceRoot: hashDomain("aloha/production-runtime-boundary-material-invalid/v1", { kind, reasons, evidence }),
  });
}

export function issueProductionRuntimeRestartMaterialObserverPortV1(
  input: Readonly<{
    readonly productionEvidenceDatabasePath: string;
    readonly checkpointDatabasePath: string;
    readonly sink: ContentAddressedObserverSinkV1;
    readonly qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1;
  }>,
): ProductionRuntimeRestartMaterialObserverPortV1 {
  if (input === null || typeof input !== "object" || Reflect.ownKeys(input).length !== 4) {
    throw new TypeError("runtime restart observer input has non-exact fields");
  }
  const databasePath = absolutePath(input.productionEvidenceDatabasePath, "runtime restart evidence database path");
  const checkpointDatabasePath = absolutePath(input.checkpointDatabasePath, "runtime restart checkpoint database path");
  if (!(input.sink instanceof ContentAddressedObserverSinkV1)) throw new TypeError("runtime restart observer requires collector-owned content sink");
  const lineage = readQualifiedReleaseLineageObservationV1(input.qualifiedReleaseRunner);
  const releaseBinding = Object.freeze({
    candidateReleaseCommit: lineage.boundary.candidateReleaseCommit,
    runtimeBindingId: lineage.runtimeBinding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(lineage.runtimeBinding),
  });
  return issueProductionRuntimeRestartMaterialObserverOwnerPortV1(releaseBinding, async () => {
    if (!existsSync(databasePath) || !existsSync(checkpointDatabasePath)) {
      return missing("runtime-restart", [
        ...(!existsSync(databasePath) ? ["durable-production-evidence-database-missing"] : []),
        ...(!existsSync(checkpointDatabasePath) ? ["durable-checkpoint-database-missing"] : []),
      ], { databasePath, checkpointDatabasePath });
    }
    const observed = observeRuntimeAcceptanceProcessDatabaseV1(databasePath);
    const performance = observeProductionPerformanceDatabaseV1(databasePath);
    const evidence = {
      databaseSha256Before: observed.databaseSha256Before,
      databaseSha256After: observed.databaseSha256After,
      storageSetRootBefore: observed.storageSetRootBefore,
      storageSetRootAfter: observed.storageSetRootAfter,
      sqliteSchemaRoot: observed.sqliteSchemaRoot,
      rawRowRoot: observed.rawRowRoot,
      eventRoot: observed.eventRoot,
      events: observed.events,
      processLogs: observed.processLogs,
      performanceStatus: performance.status,
      performanceReasons: performance.reasons,
      performanceRawRowRoot: performance.rawRowRoot,
      performanceEventRoot: performance.eventRoot,
    };
    if (observed.status === "invalid") return invalid("runtime-restart", observed.reasons, evidence);
    if (observed.status !== "raw-complete") return missing("runtime-restart", observed.reasons, evidence);
    if (performance.status === "invalid") return invalid("runtime-restart", performance.reasons, evidence);
    try {
      const material = await observeProductionRuntimeRestartFactsV1({
        processDatabase: observed,
        performanceDatabase: performance,
        checkpointDatabasePath,
        sink: input.sink,
      });
      const predicateId = "aloha.runtime-restart.facts";
      const predicateFacts = Object.freeze([material.facts]);
      return Object.freeze({
        status: "available" as const,
        candidateReleaseCommit: material.candidateReleaseCommit,
        artifacts: material.artifacts,
        predicateFacts,
        evidenceRoot: productionRuntimeBoundaryMaterialEvidenceRootV1({
          predicateId,
          candidateReleaseCommit: material.candidateReleaseCommit,
          artifacts: material.artifacts,
          predicateFacts,
        }),
      });
    } catch (error) {
      return invalid("runtime-restart", [error instanceof Error ? error.message : "runtime-restart-observer-failed"], evidence);
    }
  });
}

export interface ProductionClosureMaterialObserverPortsV1 {
  readonly sourceRepository: ProductionSourceClosureMaterialObserverPortV1;
  readonly legacyAuthority: ProductionLegacyAuthorityMaterialObserverPortV1;
}

/**
 * Re-run the real compiler/source boundary and independently read the
 * receipt-bound pre-release artifacts, durable SQLite bytes, process tree,
 * executable mappings, and log window. Neither source may supply a root,
 * verdict, repository origin, or authority classification.
 */
export function issueProductionClosureMaterialObserverPortsV1(input: Readonly<{
  readonly preReleaseAdvisoryMaterial: PreReleaseAdvisoryMaterialCapabilityV1;
  readonly qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1;
  readonly observerStore: ReleaseOwnedObserverStoreCapabilityV1;
}>): ProductionClosureMaterialObserverPortsV1 {
  if (input === null || typeof input !== "object" || Reflect.ownKeys(input).length !== 3) {
    throw new TypeError("production closure observer input has non-exact fields");
  }
  const preRelease = readPreReleaseAdvisoryMaterialCapabilityV1(input.preReleaseAdvisoryMaterial);
  const lineage = readQualifiedReleaseLineageObservationV1(input.qualifiedReleaseRunner);
  const releaseBinding = Object.freeze({
    candidateReleaseCommit: lineage.boundary.candidateReleaseCommit,
    runtimeBindingId: lineage.runtimeBinding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(lineage.runtimeBinding),
  });
  if (preRelease.phase !== "pre-release"
    || preRelease.processImportReceipt.dryRun !== true
    || preRelease.processImportReceipt.stagingArtifactSetRoot !== preRelease.stagingArtifactSetRoot
    || preRelease.processImportReceipt.stagingManifestRoot !== preRelease.stagingManifestRoot) {
    throw new TypeError("production closure observer pre-release receipt is inconsistent");
  }
  readReleaseOwnedObserverStoreV1(input.observerStore);
  let rawObservation: ReturnType<typeof observeProductionClosureRawFactsV1> | null = null;
  const observe = async (predicateId: string): Promise<ProductionRuntimeBoundaryMaterialObservationV1> => {
    rawObservation ??= observeProductionClosureRawFactsV1({
      preReleaseAdvisoryMaterial: input.preReleaseAdvisoryMaterial,
      qualifiedReleaseRunner: input.qualifiedReleaseRunner,
      observerStore: input.observerStore,
    });
    const observed = await rawObservation;
    if (observed.status !== "available") {
      return observed.status === "missing"
        ? missing("legacy-closure", observed.reasons, observed.evidence)
        : invalid("legacy-closure", observed.reasons, observed.evidence);
    }
    const predicateFacts = Object.freeze([observed.facts]);
    const available = Object.freeze({
      status: "available" as const,
      candidateReleaseCommit: observed.candidateReleaseCommit,
      artifacts: observed.artifacts,
      predicateFacts,
      evidenceRoot: productionRuntimeBoundaryMaterialEvidenceRootV1({
        predicateId,
        candidateReleaseCommit: observed.candidateReleaseCommit,
        artifacts: observed.artifacts,
        predicateFacts,
      }),
    });
    return available;
  };
  return Object.freeze({
    sourceRepository: issueProductionSourceClosureMaterialObserverOwnerPortV1(releaseBinding, () => observe("aloha.source-repository-production-closure-zero")),
    legacyAuthority: issueProductionLegacyAuthorityMaterialObserverOwnerPortV1(releaseBinding, () => observe("aloha.legacy-shaped-authority-zero")),
  });
}

export type {
  ProductionLegacyAuthorityMaterialObserverPortV1,
  ProductionRuntimeRestartMaterialObserverPortV1,
  ProductionSourceClosureMaterialObserverPortV1,
};
