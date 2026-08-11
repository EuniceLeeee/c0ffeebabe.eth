import { writeFile } from "node:fs/promises";
import {
  buildArchitectureMigrationSideCapture,
  type RawArchitectureMigrationSideCapture,
  type RawFamilyMigrationCaseCapture,
  type RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";
import type { ArchitectureStateAnchor } from
  "./architecture-migration-parity.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";

export interface ArchitectureMigrationCaptureCorpus {
  readonly captureId: string;
  readonly commit: string;
  readonly productionClosureHash: string;
  readonly activationManifestHash: string;
  readonly normalizedConfigHash: string;
  readonly productionPolicyHash: string;
  readonly corpusHash: string;
  readonly evidenceRefs: readonly string[];
  readonly stateAnchors: readonly ArchitectureStateAnchor[];
  readonly familyCases: readonly RawFamilyMigrationCaseCapture[];
  readonly commonGraph?: RawArchitectureMigrationSideCapture["commonGraph"];
  readonly nonMigratedFamilies?:
    RawArchitectureMigrationSideCapture["nonMigratedFamilies"];
}

/**
 * Validates a frozen capture corpus before any replay output is assembled.
 * The corpus binds one side commit, the frozen production closure/activation/
 * config/policy/corpus fingerprints, evidence refs and a non-empty anchor set.
 */
export function validateArchitectureMigrationCaptureCorpus(
  corpus: unknown,
): ArchitectureMigrationCaptureCorpus {
  if (corpus === null || typeof corpus !== "object") {
    throw new Error("capture corpus must be an object");
  }
  const candidate = corpus as Partial<ArchitectureMigrationCaptureCorpus>;
  for (const key of [
    "captureId",
    "commit",
    "productionClosureHash",
    "activationManifestHash",
    "normalizedConfigHash",
    "productionPolicyHash",
    "corpusHash",
  ] as const) {
    const value = candidate[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(candidate.evidenceRefs) ||
    candidate.evidenceRefs.length === 0
  ) {
    throw new Error("capture corpus evidenceRefs must be non-empty");
  }
  if (
    !Array.isArray(candidate.stateAnchors) ||
    candidate.stateAnchors.length === 0
  ) {
    throw new Error("capture corpus stateAnchors must be non-empty");
  }
  if (!Array.isArray(candidate.familyCases)) {
    throw new Error("capture corpus familyCases must be an array");
  }
  return corpus as ArchitectureMigrationCaptureCorpus;
}

export function generateArchitectureMigrationSideCapture(
  corpus: ArchitectureMigrationCaptureCorpus,
): RawArchitectureMigrationSideCapture {
  return buildArchitectureMigrationSideCapture({
    captureId: corpus.captureId,
    commit: corpus.commit,
    productionClosureHash: corpus.productionClosureHash,
    activationManifestHash: corpus.activationManifestHash,
    normalizedConfigHash: corpus.normalizedConfigHash,
    productionPolicyHash: corpus.productionPolicyHash,
    corpusHash: corpus.corpusHash,
    evidenceRefs: corpus.evidenceRefs,
    familyCases: corpus.familyCases,
    commonGraph: corpus.commonGraph,
    nonMigratedFamilies: corpus.nonMigratedFamilies,
  });
}

export function architectureMigrationSideJson(
  side: RawArchitectureMigrationSideCapture,
): string {
  return `${JSON.stringify(
    side,
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
    2,
  )}\n`;
}

export async function writeArchitectureMigrationSideCapture(
  corpus: ArchitectureMigrationCaptureCorpus,
  outPath: string,
): Promise<string> {
  const side = generateArchitectureMigrationSideCapture(corpus);
  await writeFile(outPath, architectureMigrationSideJson(side), "utf8");
  return side.closure.captureId;
}

export function frameworkBlockedStage(
  evidenceRefs: readonly string[],
  blocker = "capture-harness-stage-not-wired",
): RawMigrationStageCapture {
  return Object.freeze({
    status: "framework-blocked" as const,
    items: Object.freeze([]),
    evidenceRefs: Object.freeze([...evidenceRefs]),
    blocker,
  });
}

export function exercisedStage(
  items: readonly RawMigrationStageCapture["items"][number][],
  evidenceRefs: readonly string[],
): RawMigrationStageCapture {
  return Object.freeze({
    status: "exercised" as const,
    items: Object.freeze([...items]),
    evidenceRefs: Object.freeze([...evidenceRefs]),
    blocker: null,
  });
}

export function fixtureStateAnchor(
  source: CanonicalSource,
): ArchitectureStateAnchor {
  return Object.freeze({
    number: source.number,
    hash: source.hash,
    stateRoot: `0x${"ab".repeat(32)}`,
  });
}

export function fixtureCorpusFingerprints(): {
  readonly productionClosureHash: string;
  readonly activationManifestHash: string;
  readonly normalizedConfigHash: string;
  readonly productionPolicyHash: string;
  readonly corpusHash: string;
} {
  return {
    productionClosureHash: "11".repeat(32),
    activationManifestHash: "22".repeat(32),
    normalizedConfigHash: "33".repeat(32),
    productionPolicyHash: "44".repeat(32),
    corpusHash: "55".repeat(32),
  };
}

export function buildFixtureCaptureCorpus(input: {
  readonly captureId: string;
  readonly commit: string;
  readonly source: CanonicalSource;
  readonly familyCases: readonly RawFamilyMigrationCaseCapture[];
  readonly evidenceRefs?: readonly string[];
}): ArchitectureMigrationCaptureCorpus {
  return Object.freeze({
    captureId: input.captureId,
    commit: input.commit,
    ...fixtureCorpusFingerprints(),
    evidenceRefs: Object.freeze([
      ...(input.evidenceRefs ?? ["fixture:capture-corpus"]),
    ]),
    stateAnchors: Object.freeze([fixtureStateAnchor(input.source)]),
    familyCases: Object.freeze([...input.familyCases]),
  });
}
