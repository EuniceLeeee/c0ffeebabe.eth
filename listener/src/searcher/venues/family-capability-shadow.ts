import { familyId, type FamilyId } from "./adapter-family-identifiers.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  validateGeneratedCapabilityManifest,
  type FamilyCapabilityName,
  type GeneratedCapabilityIdentity,
  type GeneratedCapabilityManifest,
} from "./family-capability-catalog.js";
import type { RuntimeSourceClosure } from "./capability-content-hash.js";

export interface CapabilityEntryRootReceipt {
  readonly capability: FamilyCapabilityName;
  readonly entrySourceFile: string | null;
  readonly entryExport: string | null;
  readonly additionalSourceFiles: readonly string[];
  readonly absence: "declared-absent" | null;
}

/** Only this record may be attached to a future strict Family catalog. */
export interface CapabilityExactShadowRecord {
  readonly precision: "capability-exact";
  readonly identity: GeneratedCapabilityIdentity;
  readonly root: CapabilityEntryRootReceipt;
}

/**
 * Observation for a monolithic legacy Family. It deliberately has neither a
 * `capability` field nor a `contentHash` field, so it cannot structurally pass
 * as GeneratedCapabilityIdentity or populate family.hashes/cache keys.
 */
export interface LegacyWholeFamilyShadowObservation {
  readonly precision: "legacy-whole-family";
  readonly familyId: FamilyId;
  readonly rootSourceFile: string;
  readonly rootExport: string;
  readonly wholeFamilyContentHash: string;
  readonly semanticSourceFiles: readonly string[];
  readonly semanticDependencies: readonly string[];
  readonly ownedActionAdapterIds: readonly string[];
  readonly closureCompleteness: "complete" | "family-source-only";
  readonly missingSemanticSurfaces: readonly string[];
  readonly manualAdapterSchemaRevision: string | null;
  readonly manualSnapshotCompatibilityRevision: string | null;
  readonly provenanceCommit: string | null;
}

export interface FamilyCapabilityShadowBuildIssue {
  readonly sourceFile: string;
  readonly code:
    | "invalid_production_entry"
    | "strict_root_not_direct_import"
    | "strict_root_shared_module"
    | "strict_family_id_unresolved"
    | "legacy_family_id_unresolved"
    | "legacy_action_closure_incomplete"
    | "capability_generation_failed";
  readonly message: string;
}

export interface FamilyCapabilityShadowArtifact {
  readonly format: "adapter-family-capability-shadow-v1";
  readonly exact: readonly CapabilityExactShadowRecord[];
  readonly legacy: readonly LegacyWholeFamilyShadowObservation[];
  readonly issues: readonly FamilyCapabilityShadowBuildIssue[];
  readonly complete: boolean;
  readonly artifactHash: string;
}

export function legacyWholeFamilyShadowObservation(input: {
  readonly familyId: FamilyId;
  readonly rootSourceFile: string;
  readonly rootExport: string;
  readonly closure: RuntimeSourceClosure;
  readonly ownedActionAdapterIds: readonly string[];
  readonly closureCompleteness: "complete" | "family-source-only";
  readonly missingSemanticSurfaces?: readonly string[];
  readonly manualAdapterSchemaRevision: string | null;
  readonly manualSnapshotCompatibilityRevision: string | null;
  readonly provenanceCommit: string | null;
}): LegacyWholeFamilyShadowObservation {
  return Object.freeze({
    precision: "legacy-whole-family" as const,
    familyId: input.familyId,
    rootSourceFile: canonicalString(input.rootSourceFile, "legacy root source"),
    rootExport: canonicalString(input.rootExport, "legacy root export"),
    wholeFamilyContentHash: assertSha256(
      input.closure.closureHash,
      "legacy whole-Family content hash",
    ),
    semanticSourceFiles: Object.freeze([
      input.closure.entryLogicalId,
      ...input.closure.dependencyArtifacts
        .map((artifact) => artifact.logicalId)
        .filter((logicalId) => !isExternalLogicalId(logicalId)),
    ].sort()),
    semanticDependencies: Object.freeze(
      input.closure.dependencyArtifacts
        .map((artifact) => artifact.logicalId)
        .sort(),
    ),
    ownedActionAdapterIds: Object.freeze(
      [...new Set(input.ownedActionAdapterIds)].sort(),
    ),
    closureCompleteness: input.closureCompleteness,
    missingSemanticSurfaces: Object.freeze(
      [...new Set(input.missingSemanticSurfaces ?? [])].sort(),
    ),
    manualAdapterSchemaRevision: nullableCanonicalString(
      input.manualAdapterSchemaRevision,
      "manual adapter schema revision",
    ),
    manualSnapshotCompatibilityRevision: nullableCanonicalString(
      input.manualSnapshotCompatibilityRevision,
      "manual snapshot compatibility revision",
    ),
    provenanceCommit: assertProvenance(input.provenanceCommit),
  });
}

export function createFamilyCapabilityShadowArtifact(input: {
  readonly exact: readonly CapabilityExactShadowRecord[];
  readonly legacy: readonly LegacyWholeFamilyShadowObservation[];
  readonly issues?: readonly FamilyCapabilityShadowBuildIssue[];
}): FamilyCapabilityShadowArtifact {
  const exact = Object.freeze([...input.exact].sort((left, right) =>
    left.identity.familyId.localeCompare(right.identity.familyId) ||
    left.identity.capability.localeCompare(right.identity.capability)
  ));
  const legacy = Object.freeze([...input.legacy].sort((left, right) =>
    left.familyId.localeCompare(right.familyId)
  ));
  const issues = Object.freeze([...(input.issues ?? [])].sort((left, right) =>
    left.sourceFile.localeCompare(right.sourceFile) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  ));
  assertNoMixedPrecision(exact, legacy);
  const complete = issues.length === 0 &&
    legacy.every((item) => item.closureCompleteness === "complete");
  const projection: CanonicalValue = {
    format: "adapter-family-capability-shadow-v1",
    exact: exact.map(exactProjection),
    legacy: legacy.map(legacyProjection),
    issues: issues.map((issue) => ({
      sourceFile: issue.sourceFile,
      code: issue.code,
      message: issue.message,
    })),
    complete,
  };
  return Object.freeze({
    format: "adapter-family-capability-shadow-v1" as const,
    exact,
    legacy,
    issues,
    complete,
    artifactHash: hashCanonical(projection),
  });
}

export function serializeFamilyCapabilityShadowArtifact(
  artifact: FamilyCapabilityShadowArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/**
 * Promote only complete capability-exact shadow records selected by the
 * strict production loader. Legacy observations never become cache identity.
 */
export function generatedCapabilityManifestFromShadowArtifact(input: {
  readonly artifact: unknown;
  readonly strictFamilyIds: readonly FamilyId[];
}): GeneratedCapabilityManifest {
  const artifact = validateShadowArtifactForPromotion(input.artifact);
  if (!Array.isArray(input.strictFamilyIds)) {
    throw new Error("strict Family selection must be an array");
  }
  const selected = new Set<FamilyId>();
  for (const value of input.strictFamilyIds) {
    const id = familyId(value);
    if (selected.has(id)) {
      throw new Error(`strict Family selection duplicates ${id}`);
    }
    selected.add(id);
  }

  const allExact = validateGeneratedCapabilityManifest({
    format: "adapter-family-capabilities-v1",
    entries: artifact.exact.map((record) => record.identity),
    manifestHash: capabilityManifestHash(
      artifact.exact.map((record) => record.identity),
    ),
  });
  const exactFamilies = new Set(
    allExact.entries.map((identity) => identity.familyId),
  );
  const legacyFamilies = new Set(
    artifact.legacy.map((observation) => observation.familyId),
  );

  for (const id of exactFamilies) {
    if (!selected.has(id)) {
      throw new Error(
        `capability shadow contains unselected exact Family ${id}`,
      );
    }
  }
  for (const id of selected) {
    if (legacyFamilies.has(id)) {
      throw new Error(
        `strict Family ${id} has only a legacy whole-Family shadow`,
      );
    }
    const present = new Set(
      allExact.entries
        .filter((identity) => identity.familyId === id)
        .map((identity) => identity.capability),
    );
    const missing = FAMILY_CAPABILITY_NAMES.filter((capability) =>
      !present.has(capability)
    );
    if (missing.length > 0) {
      throw new Error(
        `strict Family ${id} is missing exact capabilities: ${missing.join(",")}`,
      );
    }
    if (present.size !== FAMILY_CAPABILITY_NAMES.length) {
      throw new Error(
        `strict Family ${id} must have exactly ` +
          `${FAMILY_CAPABILITY_NAMES.length} capabilities`,
      );
    }
  }

  return allExact;
}

function validateShadowArtifactForPromotion(
  value: unknown,
): FamilyCapabilityShadowArtifact {
  if (!isPlainRecord(value)) {
    throw new Error("capability shadow artifact must be a plain record");
  }
  assertExactObjectKeys(value, [
    "artifactHash",
    "complete",
    "exact",
    "format",
    "issues",
    "legacy",
  ]);
  if (value.format !== "adapter-family-capability-shadow-v1") {
    throw new Error(`unsupported capability shadow format ${String(value.format)}`);
  }
  if (
    !Array.isArray(value.exact) ||
    !Array.isArray(value.legacy) ||
    !Array.isArray(value.issues) ||
    typeof value.complete !== "boolean" ||
    typeof value.artifactHash !== "string"
  ) {
    throw new Error("capability shadow artifact has an invalid top-level shape");
  }
  assertSha256(value.artifactHash, "capability shadow artifact hash");

  for (const candidate of value.exact) {
    assertExactShadowRecord(candidate);
  }
  for (const candidate of value.legacy) {
    if (!isPlainRecord(candidate)) {
      throw new Error("legacy whole-Family shadow must be a plain record");
    }
    assertExactObjectKeys(candidate, [
      "closureCompleteness",
      "familyId",
      "manualAdapterSchemaRevision",
      "manualSnapshotCompatibilityRevision",
      "missingSemanticSurfaces",
      "ownedActionAdapterIds",
      "precision",
      "provenanceCommit",
      "rootExport",
      "rootSourceFile",
      "semanticDependencies",
      "semanticSourceFiles",
      "wholeFamilyContentHash",
    ]);
    if (candidate.precision !== "legacy-whole-family") {
      throw new Error("legacy shadow precision must be legacy-whole-family");
    }
    familyId(canonicalString(candidate.familyId, "legacy shadow Family id"));
    canonicalString(candidate.rootSourceFile, "legacy root source file");
    canonicalString(candidate.rootExport, "legacy root export");
    assertSha256(
      candidate.wholeFamilyContentHash,
      "legacy whole-Family content hash",
    );
    canonicalStringArray(candidate.semanticSourceFiles, "legacy source files");
    canonicalStringArray(
      candidate.semanticDependencies,
      "legacy semantic dependencies",
    );
    canonicalStringArray(
      candidate.ownedActionAdapterIds,
      "legacy owned ActionAdapter ids",
    );
    canonicalStringArray(
      candidate.missingSemanticSurfaces,
      "legacy missing semantic surfaces",
    );
    if (
      candidate.closureCompleteness !== "complete" &&
      candidate.closureCompleteness !== "family-source-only"
    ) {
      throw new Error("legacy shadow closure completeness is invalid");
    }
    nullableCanonicalString(
      candidate.manualAdapterSchemaRevision,
      "legacy manual adapter schema revision",
    );
    nullableCanonicalString(
      candidate.manualSnapshotCompatibilityRevision,
      "legacy manual snapshot compatibility revision",
    );
    assertProvenance(candidate.provenanceCommit);
  }
  for (const candidate of value.issues) {
    if (!isPlainRecord(candidate)) {
      throw new Error("capability shadow issue must be a plain record");
    }
    assertExactObjectKeys(candidate, ["code", "message", "sourceFile"]);
    canonicalString(candidate.sourceFile, "capability shadow issue source");
    canonicalString(candidate.code, "capability shadow issue code");
    canonicalString(candidate.message, "capability shadow issue message");
  }

  const artifact = value as unknown as FamilyCapabilityShadowArtifact;
  let rebuilt: FamilyCapabilityShadowArtifact;
  try {
    rebuilt = createFamilyCapabilityShadowArtifact({
      exact: artifact.exact,
      legacy: artifact.legacy,
      issues: artifact.issues,
    });
  } catch (error) {
    throw new Error(`invalid capability shadow artifact: ${errorMessage(error)}`);
  }
  if (artifact.complete !== rebuilt.complete) {
    throw new Error("capability shadow complete flag is stale or invalid");
  }
  if (artifact.artifactHash !== rebuilt.artifactHash) {
    throw new Error("capability shadow artifact hash is stale or invalid");
  }
  if (!artifact.complete || artifact.issues.length > 0) {
    throw new Error(
      `capability shadow is incomplete (${artifact.issues.length} issues)`,
    );
  }
  return rebuilt;
}

function assertExactShadowRecord(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new Error("capability-exact shadow must be a plain record");
  }
  assertExactObjectKeys(value, ["identity", "precision", "root"]);
  if (value.precision !== "capability-exact") {
    throw new Error("exact shadow precision must be capability-exact");
  }
  if (!isPlainRecord(value.identity) || !isPlainRecord(value.root)) {
    throw new Error("capability-exact shadow identity/root must be records");
  }
  assertExactObjectKeys(value.root, [
    "absence",
    "additionalSourceFiles",
    "capability",
    "entryExport",
    "entrySourceFile",
  ]);
  if (value.root.capability !== value.identity.capability) {
    throw new Error("capability-exact root and identity capability disagree");
  }
  const additional = canonicalStringArray(
    value.root.additionalSourceFiles,
    "capability root additionalSourceFiles",
  );
  if (value.root.absence === "declared-absent") {
    if (
      value.root.entrySourceFile !== null ||
      value.root.entryExport !== null ||
      additional.length !== 0
    ) {
      throw new Error("declared-absent capability root is invalid");
    }
    return;
  }
  if (value.root.absence !== null) {
    throw new Error("capability root absence must be null or declared-absent");
  }
  canonicalString(value.root.entrySourceFile, "capability root source file");
  canonicalString(value.root.entryExport, "capability root export");
}

function canonicalStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const strings = value.map((item) => canonicalString(item, label));
  const canonical = [...new Set(strings)].sort();
  if (
    canonical.length !== strings.length ||
    canonical.some((item, index) => item !== strings[index])
  ) {
    throw new Error(`${label} must be unique and sorted`);
  }
  return canonical;
}

function assertExactObjectKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new Error(
      `capability shadow keys must be exactly ${canonicalExpected.join(",")}`,
    );
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoMixedPrecision(
  exact: readonly CapabilityExactShadowRecord[],
  legacy: readonly LegacyWholeFamilyShadowObservation[],
): void {
  const exactFamilies = new Set<FamilyId>();
  const exactKeys = new Set<string>();
  for (const record of exact) {
    const key = `${record.identity.familyId}\0${record.identity.capability}`;
    if (exactKeys.has(key)) {
      throw new Error(
        `duplicate exact capability shadow ${record.identity.familyId}/` +
          record.identity.capability,
      );
    }
    exactKeys.add(key);
    exactFamilies.add(record.identity.familyId);
  }
  const legacyFamilies = new Set<FamilyId>();
  for (const observation of legacy) {
    if (legacyFamilies.has(observation.familyId)) {
      throw new Error(`duplicate legacy shadow ${observation.familyId}`);
    }
    legacyFamilies.add(observation.familyId);
    if (exactFamilies.has(observation.familyId)) {
      throw new Error(
        `Family ${observation.familyId} cannot be both capability-exact and legacy`,
      );
    }
  }
}

function exactProjection(record: CapabilityExactShadowRecord): CanonicalValue {
  return {
    precision: record.precision,
    identity: {
      familyId: record.identity.familyId,
      capability: record.identity.capability,
      contractVersion: record.identity.contractVersion,
      contentHash: record.identity.contentHash,
      semanticDependencies: record.identity.semanticDependencies,
      provenanceCommit: record.identity.provenanceCommit,
    },
    root: {
      capability: record.root.capability,
      entrySourceFile: record.root.entrySourceFile,
      entryExport: record.root.entryExport,
      additionalSourceFiles: record.root.additionalSourceFiles,
      absence: record.root.absence,
    },
  };
}

function legacyProjection(
  observation: LegacyWholeFamilyShadowObservation,
): CanonicalValue {
  return {
    precision: observation.precision,
    familyId: observation.familyId,
    rootSourceFile: observation.rootSourceFile,
    rootExport: observation.rootExport,
    wholeFamilyContentHash: observation.wholeFamilyContentHash,
    semanticSourceFiles: observation.semanticSourceFiles,
    semanticDependencies: observation.semanticDependencies,
    ownedActionAdapterIds: observation.ownedActionAdapterIds,
    closureCompleteness: observation.closureCompleteness,
    missingSemanticSurfaces: observation.missingSemanticSurfaces,
    manualAdapterSchemaRevision: observation.manualAdapterSchemaRevision,
    manualSnapshotCompatibilityRevision:
      observation.manualSnapshotCompatibilityRevision,
    provenanceCommit: observation.provenanceCommit,
  };
}

function isExternalLogicalId(logicalId: string): boolean {
  return logicalId.startsWith("package:") ||
    logicalId.startsWith("runtime:") ||
    logicalId.startsWith("contract:");
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
  return value;
}

function canonicalString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function nullableCanonicalString(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : canonicalString(value, label);
}

function assertProvenance(value: unknown): string | null {
  if (
    value !== null &&
    (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value))
  ) {
    throw new Error("shadow provenanceCommit must be a git object id");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
