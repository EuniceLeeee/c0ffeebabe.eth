import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  encodeCanonicalBytes,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { buildHistoricalFamilyAdvisoryReportV1 } from "./advisory-report.ts";
import { loadHistoricalExecutionPrefixV1 } from "./execution-prefix.ts";
import { loadGeneratedFamilySearchAdapterBindingV1 } from "./family-current-source-replay.ts";
import {
  buildHistoricalFamilyAdvisoryMatrixV1,
  HISTORICAL_FAMILY_SPECIMENS_V1,
  type HistoricalSpecimenDescriptorV1,
} from "./family-advisory-matrix.ts";
import { loadHistoricalFamilyFactBundleV1 } from "./index.ts";

export type ReleaseHistoricalFamilyIdV1 =
  | "curve-underlying"
  | "dodo-v2"
  | "fluid-dex"
  | "univ2-standard";

export type ReleaseFamilyFactClosureStatusV1 = "pass" | "partial" | "missing";

export type ReleaseFamilyFactClosureGapV1 =
  | "immutable-historical-bundle"
  | "reverse-verified-pool-identity"
  | "historical-execution-prefix"
  | "generated-adapter-current-source-transcript"
  | "generated-adapter-same-case-run"
  | "revm-historical-effects"
  | "effects-equality-comparison"
  | "callback-variant-current-action-coverage";

interface ReleaseFamilyHistoricalLocatorV1 {
  readonly familyId: ReleaseHistoricalFamilyIdV1;
  readonly manifestRoot: Hash;
  readonly txHash: Hash;
  readonly canonicalBlockHash: Hash;
  readonly locatorOrigin: "immutable-cas" | "old-impl-read-only-seed-confirmed-by-immutable-cas";
}

export const RELEASE_FAMILY_HISTORICAL_LOCATORS_V1: readonly ReleaseFamilyHistoricalLocatorV1[] = Object.freeze([
  Object.freeze({
    familyId: "curve-underlying",
    manifestRoot: "0x15bcdb923bd656196fb6bf227fc3f47f740d4d8f4e89f7a63327f643129e6c5b",
    txHash: "0x149df3ec17a6044e0c66c25aa55ce044abe33bf14cedea26295e1b6d4c9fde60",
    canonicalBlockHash: "0x5a1cbd6b472206d2c695f4960d177e5b78188ac277c441f4a60da71ce7ede3fa",
    locatorOrigin: "immutable-cas",
  }),
  Object.freeze({
    familyId: "dodo-v2",
    manifestRoot: "0x4c05aa01aaf0c63d2becccc367e49442268fb3bf5f5be0c071b8292ae0ca3b99",
    txHash: "0xdc52761ffb79eaf37df696b3ed0eff0e7befbec224caaecf61a7a68f0e2cdfc4",
    canonicalBlockHash: "0x90e8b454a84230787647ae09c34238823904c38a53329b9a5e6c55b896c0b84c",
    locatorOrigin: "immutable-cas",
  }),
  Object.freeze({
    familyId: "fluid-dex",
    manifestRoot: "0x9bd03723469a26ceb826038783348a5577d31c72f548a864545104f71917f4b3",
    txHash: "0xbd30e0b400d101183b52154c37b085f8a5a0cd35929ffbbf3d3d5145adb14ab6",
    canonicalBlockHash: "0x154711a7d062ba8c9f38a7aece109beccc079384b6c7f0d3ab75929c77e0c6a7",
    locatorOrigin: "immutable-cas",
  }),
  Object.freeze({
    familyId: "univ2-standard",
    manifestRoot: "0x687f562d19c0e1e0aa939d7c81067b5b283f0d5b1f44408664e1474ee136c259",
    txHash: "0x0ffa9acf81b5631ac91d1c141adbbe884ad0bdd991143bd13cd10eacc2fc8454",
    canonicalBlockHash: "0x58202b31ed2ba7d3410860d8e345da2c3c4e7a94ba8526141e621e32361d4cf7",
    locatorOrigin: "old-impl-read-only-seed-confirmed-by-immutable-cas",
  }),
]);

export interface ReleaseFamilyHistoricalObservationV1 {
  readonly status: "observed" | "missing";
  readonly selectorEvidenceRoots: readonly Hash[];
  readonly historicalCaseIds: readonly Hash[];
  readonly observedDirections: readonly ("zero-for-one" | "one-for-zero")[];
  readonly observedSettlementModes: readonly string[];
  readonly currentShapeComparisonStatuses: readonly string[];
  readonly currentShapeComparisonReasonCodes: readonly string[];
}

export interface ReleaseFamilyFactClosureRowV1 {
  readonly familyId: ReleaseHistoricalFamilyIdV1;
  readonly status: ReleaseFamilyFactClosureStatusV1;
  readonly locator: ReleaseFamilyHistoricalLocatorV1;
  readonly immutableBundleObserved: boolean;
  readonly historicalObservation: ReleaseFamilyHistoricalObservationV1;
  readonly generatedSearchBinding: Readonly<{
    familyDefinitionHash: Hash;
    modulePath: string;
    exportName: string;
    closureRoot: Hash;
    leafDigest: Hash;
    generatedRuntimeSourceHash: Hash;
  }> | null;
  readonly executionPrefixManifestRoots: readonly Hash[];
  readonly currentSourceManifestRoots: readonly Hash[];
  readonly candidateGeneratedManifestRoots: readonly Hash[];
  readonly factContract: Readonly<{
    historicalOracle: "observed" | "missing";
    currentGeneratedBinding: "observed" | "missing";
    currentSourceReplay: "missing" | "unjoined";
    executionPrefix: "missing" | "observed";
    candidateGeneratedExecution: "missing" | "unjoined";
    currentGeneratedEffectObservation: "missing";
    effectsEquality: "missing";
  }>;
  readonly exactGaps: readonly ReleaseFamilyFactClosureGapV1[];
  readonly rowRoot: Hash;
}

export interface ReleaseFamilyFactClosureReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.release-family-historical-fact-closure-v1";
  readonly advisoryOnly: true;
  readonly networkAcquisitionUsed: false;
  readonly authorityClaim: "none";
  readonly qualificationClaim: "none";
  readonly rows: readonly ReleaseFamilyFactClosureRowV1[];
  readonly reportRoot: Hash;
}

function regularJsonFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return Object.freeze([]);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError(`unsafe manifest directory: ${directory}`);
  return Object.freeze(readdirSync(directory)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => join(directory, name))
    .filter((path) => {
      const candidate = lstatSync(path);
      return candidate.isFile() && !candidate.isSymbolicLink();
    }));
}

function canonicalObject(path: string): Record<string, unknown> {
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`manifest is not an object: ${path}`);
  }
  if (!Buffer.from(encodeCanonicalBytes(value as CanonicalJson)).equals(bytes)) {
    throw new TypeError(`manifest bytes are not canonical: ${path}`);
  }
  return value as Record<string, unknown>;
}

function manifestRoot(value: unknown): Hash | null {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) ? value as Hash : null;
}

function matchingExecutionPrefixes(rootDirectory: string, historicalManifestRoot: Hash): readonly Hash[] {
  const roots = regularJsonFiles(join(resolve(rootDirectory), "execution-prefix", "manifests"))
    .flatMap((path) => {
      const value = canonicalObject(path);
      const root = manifestRoot(value.manifestRoot);
      return value.kind === "aloha.historical-execution-prefix-manifest"
        && value.historicalFamilyFactManifestRoot === historicalManifestRoot
        && root !== null
        ? [root]
        : [];
    }).sort();
  for (const root of roots) loadHistoricalExecutionPrefixV1(rootDirectory, root);
  return Object.freeze(roots);
}

function matchingCurrentSourceReplays(rootDirectory: string, familyId: ReleaseHistoricalFamilyIdV1): readonly Hash[] {
  return Object.freeze(regularJsonFiles(join(resolve(rootDirectory), "family-current-source-replay-v1", "manifests"))
    .flatMap((path) => {
      const value = canonicalObject(path);
      const binding = value.canonicalGeneratedBinding;
      const root = manifestRoot(value.manifestRoot);
      return value.kind === "aloha.family-current-source-replay-manifest-v1"
        && binding !== null
        && typeof binding === "object"
        && !Array.isArray(binding)
        && (binding as Record<string, unknown>).familyId === familyId
        && root !== null
        ? [root]
        : [];
    }).sort());
}

function matchingCandidateRuns(rootDirectory: string, familyId: ReleaseHistoricalFamilyIdV1): readonly Hash[] {
  return Object.freeze(regularJsonFiles(join(resolve(rootDirectory), "candidate-generated-search-adapter-v1", "manifests"))
    .flatMap((path) => {
      const value = canonicalObject(path);
      const binding = value.binding;
      const root = manifestRoot(value.manifestRoot);
      return value.kind === "aloha.candidate-generated-search-adapter-diagnostic-v1"
        && binding !== null
        && typeof binding === "object"
        && !Array.isArray(binding)
        && (binding as Record<string, unknown>).familyId === familyId
        && root !== null
        ? [root]
        : [];
    }).sort());
}

function emptyObservation(): ReleaseFamilyHistoricalObservationV1 {
  return Object.freeze({
    status: "missing",
    selectorEvidenceRoots: Object.freeze([]),
    historicalCaseIds: Object.freeze([]),
    observedDirections: Object.freeze([]),
    observedSettlementModes: Object.freeze([]),
    currentShapeComparisonStatuses: Object.freeze([]),
    currentShapeComparisonReasonCodes: Object.freeze([]),
  });
}

function matrixSpecimen(familyId: Exclude<ReleaseHistoricalFamilyIdV1, "univ2-standard">): HistoricalSpecimenDescriptorV1 {
  const matches = HISTORICAL_FAMILY_SPECIMENS_V1.filter((item) => item.family === familyId);
  if (matches.length !== 1) throw new TypeError(`exact historical specimen descriptor missing for ${familyId}`);
  return matches[0]!;
}

function historicalObservation(
  rootDirectory: string,
  familyId: ReleaseHistoricalFamilyIdV1,
): ReleaseFamilyHistoricalObservationV1 {
  if (familyId === "univ2-standard") {
    const locator = RELEASE_FAMILY_HISTORICAL_LOCATORS_V1.find((item) => item.familyId === familyId)!;
    const report = buildHistoricalFamilyAdvisoryReportV1(rootDirectory, locator.manifestRoot);
    return Object.freeze({
      status: "observed",
      selectorEvidenceRoots: Object.freeze(report.cases.map((item) => item.calldataSha256)),
      historicalCaseIds: Object.freeze(report.cases.map((item) => item.caseId)),
      observedDirections: Object.freeze([...new Set(report.cases.map((item) => item.direction))].sort()),
      observedSettlementModes: Object.freeze([...new Set(report.cases.map((item) => item.settlementMode))].sort()),
      currentShapeComparisonStatuses: Object.freeze(report.cases.map((item) => item.comparison.status)),
      currentShapeComparisonReasonCodes: Object.freeze([...new Set(report.cases.flatMap((item) => item.comparison.reasonCodes))].sort()),
    });
  }
  const row = buildHistoricalFamilyAdvisoryMatrixV1(rootDirectory, [matrixSpecimen(familyId)]).rows[0]!;
  return Object.freeze({
    status: "observed",
    selectorEvidenceRoots: Object.freeze([row.selectorShape.evidenceRoot, row.variantObservation.evidenceRoot]),
    historicalCaseIds: Object.freeze([]),
    observedDirections: Object.freeze([]),
    observedSettlementModes: Object.freeze([]),
    currentShapeComparisonStatuses: Object.freeze([row.currentActionBinding.status]),
    currentShapeComparisonReasonCodes: Object.freeze([...row.currentActionBinding.reasonCodes]),
  });
}

function row(rootDirectory: string, locator: ReleaseFamilyHistoricalLocatorV1): ReleaseFamilyFactClosureRowV1 {
  const manifestPath = join(resolve(rootDirectory), "manifests", `${locator.manifestRoot.slice(2)}.json`);
  const immutableBundleObserved = existsSync(manifestPath);
  let observation = emptyObservation();
  if (immutableBundleObserved) {
    const bundle = loadHistoricalFamilyFactBundleV1(rootDirectory, locator.manifestRoot);
    if (
      bundle.manifest.txHash !== locator.txHash
      || bundle.manifest.canonicalBlockHash !== locator.canonicalBlockHash
    ) throw new TypeError(`historical locator splice for ${locator.familyId}`);
    observation = historicalObservation(rootDirectory, locator.familyId);
  }

  let generatedSearchBinding: ReleaseFamilyFactClosureRowV1["generatedSearchBinding"] = null;
  try {
    const binding = loadGeneratedFamilySearchAdapterBindingV1(locator.familyId);
    generatedSearchBinding = Object.freeze({
      familyDefinitionHash: binding.familyDefinitionHash,
      modulePath: binding.modulePath,
      exportName: binding.exportName,
      closureRoot: binding.closureRoot,
      leafDigest: binding.leafDigest,
      generatedRuntimeSourceHash: binding.generatedRuntimeSourceHash,
    });
  } catch {
    generatedSearchBinding = null;
  }

  const executionPrefixManifestRoots = matchingExecutionPrefixes(rootDirectory, locator.manifestRoot);
  const currentSourceManifestRoots = matchingCurrentSourceReplays(rootDirectory, locator.familyId);
  const candidateGeneratedManifestRoots = matchingCandidateRuns(rootDirectory, locator.familyId);
  const gaps: ReleaseFamilyFactClosureGapV1[] = [];
  if (!immutableBundleObserved) gaps.push("immutable-historical-bundle");
  if (observation.status === "observed") gaps.push("reverse-verified-pool-identity");
  if (executionPrefixManifestRoots.length === 0) gaps.push("historical-execution-prefix");
  gaps.push("generated-adapter-current-source-transcript");
  gaps.push("generated-adapter-same-case-run");
  gaps.push("revm-historical-effects");
  gaps.push("effects-equality-comparison");
  if (
    locator.familyId === "univ2-standard"
    && observation.currentShapeComparisonReasonCodes.includes("variant-not-covered")
  ) gaps.push("callback-variant-current-action-coverage");
  const exactGaps = Object.freeze([...new Set(gaps)]);
  const factContract = Object.freeze({
    historicalOracle: observation.status,
    currentGeneratedBinding: generatedSearchBinding === null ? "missing" as const : "observed" as const,
    currentSourceReplay: currentSourceManifestRoots.length === 0 ? "missing" as const : "unjoined" as const,
    executionPrefix: executionPrefixManifestRoots.length === 0 ? "missing" as const : "observed" as const,
    candidateGeneratedExecution: candidateGeneratedManifestRoots.length === 0 ? "missing" as const : "unjoined" as const,
    currentGeneratedEffectObservation: "missing" as const,
    effectsEquality: "missing" as const,
  });
  const status: ReleaseFamilyFactClosureStatusV1 = !immutableBundleObserved || generatedSearchBinding === null
    ? "missing"
    : exactGaps.length === 0
      ? "pass"
      : "partial";
  const body = Object.freeze({
    familyId: locator.familyId,
    status,
    locator,
    immutableBundleObserved,
    historicalObservation: observation,
    generatedSearchBinding,
    executionPrefixManifestRoots,
    currentSourceManifestRoots,
    candidateGeneratedManifestRoots,
    factContract,
    exactGaps,
  });
  return Object.freeze({ ...body, rowRoot: hashDomain("aloha/release-family-historical-fact-closure-row/v1", body) });
}

/**
 * Read-only audit. Presence of trace/receipt facts or a generated binding never
 * upgrades a Family to calibrated; pass requires a joined same-case execution
 * prefix, generated Adapter run, REVM effects, and an exact effects comparison.
 */
export function auditReleaseFamilyHistoricalFactsV1(
  rootDirectory: string,
): ReleaseFamilyFactClosureReportV1 {
  const rows = Object.freeze(RELEASE_FAMILY_HISTORICAL_LOCATORS_V1.map((item) => row(rootDirectory, item)));
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.release-family-historical-fact-closure-v1" as const,
    advisoryOnly: true as const,
    networkAcquisitionUsed: false as const,
    authorityClaim: "none" as const,
    qualificationClaim: "none" as const,
    rows,
  });
  return Object.freeze({ ...body, reportRoot: hashDomain("aloha/release-family-historical-fact-closure/v1", body) });
}
