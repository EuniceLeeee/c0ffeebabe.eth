import {
  arraySchema,
  canonicalObjectSchema,
  decodeCanonicalJson,
  decimalStringSchema,
  defineSchema,
  defineSchemaManifest,
  encodeCanonicalBytes,
  enumSchema,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  literalSchema,
  nullableSchema,
  nonEmptyStringSchema,
  objectSchema,
  readOwnEnumerableDataProperty,
  type CanonicalJson,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";

export type TerminalSelectionCodecInput = string | Uint8Array | object;

const artifactRoleSchema = objectSchema({
  role: nonEmptyStringSchema,
  artifactRefId: hashSchema,
});

const positiveDecimalSchema = defineSchema<string>(
  { kind: "canonical-positive-decimal-string" },
  (value, path = "$") => {
    const decoded = decimalStringSchema.decode(value, path);
    if (decoded === "0") {
      throw new TypeError(`expected canonical positive decimal at ${path}`);
    }
    return decoded;
  },
);

const nullableHashSchema = defineSchema<Hash | null>(
  { kind: "nullable-hash" },
  (value, path = "$") => value === null ? null : hashSchema.decode(value, path),
);

const releaseIdentitySchema = objectSchema({
  bindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
});

const servingIdentitySchema = objectSchema({
  generationId: nonEmptyStringSchema,
  graphRoot: hashSchema,
  readyRecordHash: hashSchema,
  sourceCoverageRoot: hashSchema,
});

const currentSourceSchema = objectSchema({
  chainId: decimalStringSchema,
  number: decimalStringSchema,
  hash: hashSchema,
  stateRoot: hashSchema,
});

const canonicalHeadSchema = objectSchema({
  chainId: decimalStringSchema,
  number: decimalStringSchema,
  hash: hashSchema,
  parentHash: hashSchema,
  stateRoot: hashSchema,
});

const producerSchedulerJoinSchema = objectSchema({
  correlationId: hashSchema,
  generationId: nonEmptyStringSchema,
  source: currentSourceSchema,
  programHash: hashSchema,
  finalSimulationReceiptHash: hashSchema,
  unsignedDryRunCandidateId: hashSchema,
  unsignedDryRunLineageHash: hashSchema,
});

const manifestFullFamilySchema = objectSchema({
  projectionArtifactRefId: hashSchema,
  projectionContentSha256: hashSchema,
});

const fullFamilyProjectionCoreSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.production-terminal-phase-full-family-projection-v1"),
  status: enumSchema(["observed", "missing"] as const),
  finalDurableWindowId: hashSchema,
  readyRecordHash: hashSchema,
  auditRoot: hashSchema,
  fullGraphCoarseSweepRoot: hashSchema,
  producerTerminalBindingRoot: hashSchema,
  laneTerminalSetRoot: hashSchema,
  bundleContentSha256: nullableHashSchema,
  locatorContentSha256: nullableHashSchema,
  missing: arraySchema(objectSchema({ code: enumSchema([
    "coarse-family-artifact-unavailable",
    "graph-transition-audit-denominator-incomplete",
  ] as const), subjectRoot: hashSchema })),
});

const fullFamilyProjectionSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.production-terminal-phase-full-family-projection-v1"),
  status: enumSchema(["observed", "missing"] as const),
  finalDurableWindowId: hashSchema,
  readyRecordHash: hashSchema,
  auditRoot: hashSchema,
  fullGraphCoarseSweepRoot: hashSchema,
  producerTerminalBindingRoot: hashSchema,
  laneTerminalSetRoot: hashSchema,
  bundleContentSha256: nullableHashSchema,
  locatorContentSha256: nullableHashSchema,
  missing: arraySchema(objectSchema({ code: enumSchema([
    "coarse-family-artifact-unavailable",
    "graph-transition-audit-denominator-incomplete",
  ] as const), subjectRoot: hashSchema })),
  observationRoot: hashSchema,
});

const terminalSelectionFactSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.terminal-selection-lineage-fact-v1"),
  artifacts: arraySchema(artifactRoleSchema),
});

const selectedSelectionSchema = objectSchema({
  finalDurableWindowId: hashSchema,
  selectionPolicyDigest: hashSchema,
  eligibleSuccessCount: positiveDecimalSchema,
  eligibleSuccessRoot: hashSchema,
  selectedIndex: literalSchema("0"),
  selectedProducerTerminalId: hashSchema,
  selectedPerformanceEventId: hashSchema,
  selectedProducerTerminalEventId: hashSchema,
  selectionRoot: hashSchema,
});

const missingSelectionSchema = objectSchema({
  finalDurableWindowId: hashSchema,
  selectionPolicyDigest: hashSchema,
  eligibleSuccessCount: literalSchema("0"),
  eligibleSuccessRoot: hashSchema,
  selectedIndex: literalSchema(null),
  selectedProducerTerminalId: literalSchema(null),
  selectedPerformanceEventId: literalSchema(null),
  selectedProducerTerminalEventId: literalSchema(null),
  selectionRoot: hashSchema,
});

type SelectionUnion = Infer<typeof selectedSelectionSchema> | Infer<typeof missingSelectionSchema>;
const selectionSchema = defineSchema<SelectionUnion>(
  { kind: "union", variants: [selectedSelectionSchema.descriptor, missingSelectionSchema.descriptor] },
  (value, path = "$") => readOwnEnumerableDataProperty(value, "selectedIndex", path) === null
    ? missingSelectionSchema.decode(value, path)
    : selectedSelectionSchema.decode(value, path),
);

const rawSelectionObservationCoreSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.raw-terminal-selection-observation-v1"),
  sourceKind: literalSchema("readonly-sqlite-snapshot"),
  databaseSha256Before: hashSchema,
  databaseSha256After: hashSchema,
  storageSetRootBefore: hashSchema,
  storageSetRootAfter: hashSchema,
  sqliteSchemaRoot: hashSchema,
  rawRowRoot: hashSchema,
  eventRoot: hashSchema,
  terminalPhaseRowCount: decimalStringSchema,
  terminalPhaseRowRoot: hashSchema,
  release: releaseIdentitySchema,
  serving: servingIdentitySchema,
  selection: selectionSchema,
});

const rawSelectionObservationSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.raw-terminal-selection-observation-v1"),
  sourceKind: literalSchema("readonly-sqlite-snapshot"),
  databaseSha256Before: hashSchema,
  databaseSha256After: hashSchema,
  storageSetRootBefore: hashSchema,
  storageSetRootAfter: hashSchema,
  sqliteSchemaRoot: hashSchema,
  rawRowRoot: hashSchema,
  eventRoot: hashSchema,
  terminalPhaseRowCount: decimalStringSchema,
  terminalPhaseRowRoot: hashSchema,
  release: releaseIdentitySchema,
  serving: servingIdentitySchema,
  selection: selectionSchema,
  observationRoot: hashSchema,
});

const terminalSixStepSchema = objectSchema({
  status: enumSchema(["observed", "missing", "invalid"] as const),
  observationRoot: hashSchema,
  windowSelectionRoot: nullableHashSchema,
  selectionPolicyDigest: nullableHashSchema,
  eligibleSuccessCount: nullableSchema(decimalStringSchema),
  eligibleSuccessRoot: nullableHashSchema,
  selectedIndex: nullableSchema(literalSchema("0")),
  selectedProducerTerminalId: nullableHashSchema,
  reason: nullableSchema(nonEmptyStringSchema),
  joinedProcessEvidenceRoot: nullableHashSchema,
  performanceAppendRecordId: nullableHashSchema,
  producerTerminalAppendRecordId: nullableHashSchema,
  predicateArtifactCount: decimalStringSchema,
  predicateArtifactRoot: hashSchema,
  eventArtifactRefIds: arraySchema(hashSchema),
});

const terminalManifestCoreSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.production-terminal-phase-manifest-v1"),
  finalDurableWindowId: hashSchema,
  windowId: hashSchema,
  releaseAnchorRoot: hashSchema,
  runtimeAnchorRoot: hashSchema,
  runtimeArtifactRoot: hashSchema,
  processAnchorRoot: hashSchema,
  fullGraphCoarseSweepRoot: hashSchema,
  terminalPhaseInvocationRoot: hashSchema,
  fullFamily: manifestFullFamilySchema,
  sixStep: terminalSixStepSchema,
});

const terminalManifestSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.production-terminal-phase-manifest-v1"),
  finalDurableWindowId: hashSchema,
  windowId: hashSchema,
  releaseAnchorRoot: hashSchema,
  runtimeAnchorRoot: hashSchema,
  runtimeArtifactRoot: hashSchema,
  processAnchorRoot: hashSchema,
  fullGraphCoarseSweepRoot: hashSchema,
  terminalPhaseInvocationRoot: hashSchema,
  fullFamily: manifestFullFamilySchema,
  sixStep: terminalSixStepSchema,
  manifestRoot: hashSchema,
});

const durableAppendSchema = objectSchema({
  namespace: nonEmptyStringSchema,
  sequence: decimalStringSchema,
  eventId: hashSchema,
  contentSha256: hashSchema,
  byteLength: decimalStringSchema,
  offsetStart: decimalStringSchema,
  offsetEnd: decimalStringSchema,
  fsynced: literalSchema(true),
});

const runtimeAnchorSchema = objectSchema({
  kind: literalSchema("aloha.searcher-runtime-anchor-v1"),
  manifestHash: hashSchema,
  manifestArtifactSha256: hashSchema,
  bindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  runtimeArtifactRoot: hashSchema,
  implementationClosureDigest: hashSchema,
  entrypointSha256: hashSchema,
  nodeExecutableSha256: hashSchema,
  bundleModulePath: nonEmptyStringSchema,
  bundleModuleSha256: hashSchema,
  serviceName: nonEmptyStringSchema,
  systemdUnit: nonEmptyStringSchema,
  bootId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  logDevice: decimalStringSchema,
  logInode: decimalStringSchema,
  pid: decimalStringSchema,
  processStartTicks: decimalStringSchema,
  dryRun: literalSchema(true),
});

const processEvidenceCoreSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.searcher-production-six-step-process-evidence-v1"),
  runtimeBindingId: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  releaseProvenanceHash: hashSchema,
  terminalBindingRoot: hashSchema,
  traceRoot: hashSchema,
  correlationId: hashSchema,
  generationId: nonEmptyStringSchema,
  readyRecordHash: hashSchema,
  graphRoot: hashSchema,
  currentSource: currentSourceSchema,
  programHash: hashSchema,
  finalSimulationReceiptHash: hashSchema,
  stage12: canonicalObjectSchema,
  stage12Root: hashSchema,
  sixStepLineageRoot: hashSchema,
  runtimeFacts: canonicalObjectSchema,
  runtimeFactsRoot: hashSchema,
  producerSchedulerJoin: producerSchedulerJoinSchema,
  producerSchedulerJoinRoot: hashSchema,
  runtimeAnchor: runtimeAnchorSchema,
  runtimeAnchorRoot: hashSchema,
  serving: servingIdentitySchema,
  canonicalHead: canonicalHeadSchema,
  admissionId: hashSchema,
  producerTerminalId: hashSchema,
  producerTerminalBindingRoot: hashSchema,
  durableAppend: durableAppendSchema,
  durableAppendRecordId: hashSchema,
  producerTerminalDurableAppend: durableAppendSchema,
  producerTerminalDurableAppendRecordId: hashSchema,
});

const processEvidenceSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.searcher-production-six-step-process-evidence-v1"),
  runtimeBindingId: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  releaseProvenanceHash: hashSchema,
  terminalBindingRoot: hashSchema,
  traceRoot: hashSchema,
  correlationId: hashSchema,
  generationId: nonEmptyStringSchema,
  readyRecordHash: hashSchema,
  graphRoot: hashSchema,
  currentSource: currentSourceSchema,
  programHash: hashSchema,
  finalSimulationReceiptHash: hashSchema,
  stage12: canonicalObjectSchema,
  stage12Root: hashSchema,
  sixStepLineageRoot: hashSchema,
  runtimeFacts: canonicalObjectSchema,
  runtimeFactsRoot: hashSchema,
  producerSchedulerJoin: producerSchedulerJoinSchema,
  producerSchedulerJoinRoot: hashSchema,
  runtimeAnchor: runtimeAnchorSchema,
  runtimeAnchorRoot: hashSchema,
  serving: servingIdentitySchema,
  canonicalHead: canonicalHeadSchema,
  admissionId: hashSchema,
  producerTerminalId: hashSchema,
  producerTerminalBindingRoot: hashSchema,
  durableAppend: durableAppendSchema,
  durableAppendRecordId: hashSchema,
  producerTerminalDurableAppend: durableAppendSchema,
  producerTerminalDurableAppendRecordId: hashSchema,
  evidenceRoot: hashSchema,
});

export type TerminalSelectionFactV1 = Infer<typeof terminalSelectionFactSchema>;
export type RawTerminalSelectionObservationV1 = Infer<typeof rawSelectionObservationSchema>;
export type TerminalSelectionManifestV1 = Infer<typeof terminalManifestSchema>;
export type TerminalSelectionFullFamilyProjectionV1 = Infer<typeof fullFamilyProjectionSchema>;
export type TerminalSelectionProcessEvidenceV1 = Infer<typeof processEvidenceSchema>;

function parse(value: TerminalSelectionCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

export const TERMINAL_SELECTION_SCHEMA_MANIFESTS = Object.freeze({
  fact: defineSchemaManifest("aloha.terminal-selection-lineage-fact", "1.0.0", terminalSelectionFactSchema),
  rawSelection: defineSchemaManifest("aloha.raw-terminal-selection-observation", "1.0.0", rawSelectionObservationSchema),
  fullFamilyProjection: defineSchemaManifest("aloha.production-terminal-phase-full-family-projection", "1.0.0", fullFamilyProjectionSchema),
  terminalManifest: defineSchemaManifest("aloha.production-terminal-phase-manifest", "1.0.0", terminalManifestSchema),
  processEvidence: defineSchemaManifest("aloha.observer.six-step-process-evidence", "1.0.0", processEvidenceSchema),
});

function externalArtifactSchemaRef(id: string, descriptor: unknown) {
  const version = "1.0.0";
  return Object.freeze({
    id,
    version,
    schemaHash: hashDomain("aloha/schema-definition/v1", { id, version, descriptor }),
  });
}

/** Exact schema refs written by the three independent production observers. */
export const TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS = Object.freeze({
  rawSelection: Object.freeze({
    id: TERMINAL_SELECTION_SCHEMA_MANIFESTS.rawSelection.id,
    version: TERMINAL_SELECTION_SCHEMA_MANIFESTS.rawSelection.version,
    schemaHash: TERMINAL_SELECTION_SCHEMA_MANIFESTS.rawSelection.schemaHash,
  }),
  terminalManifest: externalArtifactSchemaRef("aloha.production-terminal-phase-manifest", {
    exactKind: "aloha.production-terminal-phase-manifest-v1",
    fields: [
      "schemaVersion", "kind", "finalDurableWindowId", "windowId", "releaseAnchorRoot",
      "runtimeAnchorRoot", "runtimeArtifactRoot", "processAnchorRoot", "fullGraphCoarseSweepRoot",
      "terminalPhaseInvocationRoot", "fullFamily", "sixStep", "manifestRoot",
    ],
    fullFamilyFields: ["projectionArtifactRefId", "projectionContentSha256"],
    sixStepFields: [
      "status", "observationRoot", "windowSelectionRoot", "selectionPolicyDigest", "eligibleSuccessCount",
      "eligibleSuccessRoot", "selectedIndex", "selectedProducerTerminalId", "reason",
      "joinedProcessEvidenceRoot", "performanceAppendRecordId", "producerTerminalAppendRecordId",
      "predicateArtifactCount", "predicateArtifactRoot", "eventArtifactRefIds",
    ],
  }),
  fullFamilyProjection: externalArtifactSchemaRef("aloha.production-terminal-phase-full-family-projection", {
    exactKind: "aloha.production-terminal-phase-full-family-projection-v1",
  }),
  processEvidence: externalArtifactSchemaRef("aloha.observer.six-step-process-evidence", {
    owner: "six-step-process-evidence",
    exactKind: "aloha.searcher-production-six-step-process-evidence-v1",
  }),
});

export const TERMINAL_SELECTION_ARTIFACT_ROLES = Object.freeze([
  "raw-sqlite-selection",
  "durable-terminal-manifest",
  "full-family-projection",
  "selected-process-evidence",
] as const);
export const TERMINAL_SELECTION_SIX_STEP_PREDICATE_ARTIFACT_ROLE = "six-step-predicate-artifact" as const;

export function createTerminalSelectionFactV1(input: Readonly<{
  rawSelectionArtifactRefId: Hash;
  terminalManifestArtifactRefId: Hash;
  fullFamilyProjectionArtifactRefId: Hash;
  processEvidenceArtifactRefId: Hash;
  sixStepPredicateArtifactRefIds: readonly Hash[];
}>): TerminalSelectionFactV1 {
  return terminalSelectionFactSchema.decode({
    schemaVersion: 1,
    kind: "aloha.terminal-selection-lineage-fact-v1",
    artifacts: [
      { role: TERMINAL_SELECTION_ARTIFACT_ROLES[0], artifactRefId: input.rawSelectionArtifactRefId },
      { role: TERMINAL_SELECTION_ARTIFACT_ROLES[1], artifactRefId: input.terminalManifestArtifactRefId },
      { role: TERMINAL_SELECTION_ARTIFACT_ROLES[2], artifactRefId: input.fullFamilyProjectionArtifactRefId },
      { role: TERMINAL_SELECTION_ARTIFACT_ROLES[3], artifactRefId: input.processEvidenceArtifactRefId },
      ...[...input.sixStepPredicateArtifactRefIds].sort().map(artifactRefId => ({
        role: TERMINAL_SELECTION_SIX_STEP_PREDICATE_ARTIFACT_ROLE,
        artifactRefId,
      })),
    ],
  });
}

export function createTerminalSelectionMissingFactV1(input: Readonly<{
  rawSelectionArtifactRefId: Hash;
  terminalManifestArtifactRefId: Hash;
  fullFamilyProjectionArtifactRefId: Hash;
}>): TerminalSelectionFactV1 {
  return terminalSelectionFactSchema.decode({
    schemaVersion: 1,
    kind: "aloha.terminal-selection-lineage-fact-v1",
    artifacts: [
      { role: TERMINAL_SELECTION_ARTIFACT_ROLES[0], artifactRefId: input.rawSelectionArtifactRefId },
      { role: TERMINAL_SELECTION_ARTIFACT_ROLES[1], artifactRefId: input.terminalManifestArtifactRefId },
      { role: TERMINAL_SELECTION_ARTIFACT_ROLES[2], artifactRefId: input.fullFamilyProjectionArtifactRefId },
    ],
  });
}

export function createRawTerminalSelectionObservationV1(
  input: Omit<RawTerminalSelectionObservationV1, "schemaVersion" | "kind" | "sourceKind" | "observationRoot">,
): RawTerminalSelectionObservationV1 {
  const core = rawSelectionObservationCoreSchema.decode({
    schemaVersion: 1,
    kind: "aloha.raw-terminal-selection-observation-v1",
    sourceKind: "readonly-sqlite-snapshot",
    ...input,
  });
  return rawSelectionObservationSchema.decode({
    ...core,
    observationRoot: hashDomain("aloha/raw-terminal-selection-observation/v1", core as unknown as CanonicalJson),
  });
}

export function decodeTerminalSelectionFactV1(value: TerminalSelectionCodecInput): TerminalSelectionFactV1 {
  return terminalSelectionFactSchema.decode(parse(value));
}

export function decodeRawTerminalSelectionObservationV1(value: TerminalSelectionCodecInput): RawTerminalSelectionObservationV1 {
  const decoded = rawSelectionObservationSchema.decode(parse(value));
  const { observationRoot: _root, ...core } = decoded;
  if (decoded.observationRoot !== hashDomain("aloha/raw-terminal-selection-observation/v1", core as unknown as CanonicalJson)) {
    throw new TypeError("raw terminal selection observation root mismatch");
  }
  return decoded;
}

export function decodeTerminalSelectionFullFamilyProjectionV1(
  value: TerminalSelectionCodecInput,
): TerminalSelectionFullFamilyProjectionV1 {
  const decoded = fullFamilyProjectionSchema.decode(parse(value));
  const { observationRoot: _root, ...core } = decoded;
  const exactCore = fullFamilyProjectionCoreSchema.decode(core);
  if ((decoded.status === "observed"
      && (decoded.bundleContentSha256 === null || decoded.locatorContentSha256 === null || decoded.missing.length !== 0))
    || (decoded.status === "missing"
      && (decoded.bundleContentSha256 !== null || decoded.locatorContentSha256 !== null || decoded.missing.length === 0))
    || decoded.observationRoot !== hashDomain(
      "aloha/production-terminal-phase-full-family-projection/v1",
      exactCore as unknown as CanonicalJson,
    )) {
    throw new TypeError("terminal phase Full-Family projection mismatch");
  }
  return decoded;
}

function validateTerminalSixStep(value: Infer<typeof terminalSixStepSchema>): void {
  const eligibleSuccessCount = value.eligibleSuccessCount;
  const predicateArtifactCount = value.predicateArtifactCount;
  if ((eligibleSuccessCount !== null && !/^(?:0|[1-9]\d*)$/.test(eligibleSuccessCount))
    || !/^(?:0|[1-9]\d*)$/.test(predicateArtifactCount)) {
    throw new TypeError("terminal phase Six-Step decimal mismatch");
  }
  const hasSelection = value.windowSelectionRoot !== null;
  const hasSelectedTerminal = value.selectedIndex === "0" && value.selectedProducerTerminalId !== null;
  const hasJoinedProcess = value.joinedProcessEvidenceRoot !== null
    && value.performanceAppendRecordId !== null
    && value.producerTerminalAppendRecordId !== null;
  const hasPartialJoinedProcess = value.joinedProcessEvidenceRoot !== null
    || value.performanceAppendRecordId !== null
    || value.producerTerminalAppendRecordId !== null;
  const missingReasons = new Set(["no-successful-dry-run", "terminal-binding-missing", "joined-process-evidence-missing"]);
  const invalidReasons = new Set(["window-selection-capability-invalid", "terminal-capability-invalid", "terminal-artifact-capability-invalid", "process-capability-invalid", "terminal-process-binding-mismatch"]);
  if ((value.windowSelectionRoot === null) !== (value.selectionPolicyDigest === null)
    || (value.windowSelectionRoot === null) !== (eligibleSuccessCount === null)
    || (value.windowSelectionRoot === null) !== (value.eligibleSuccessRoot === null)
    || (value.selectedIndex === null) !== (value.selectedProducerTerminalId === null)
    || (!hasSelection && hasSelectedTerminal)
    || (hasSelection && eligibleSuccessCount === "0" && hasSelectedTerminal)
    || (hasSelection && eligibleSuccessCount !== "0" && !hasSelectedTerminal)
    || (value.status === "observed" && (!hasSelection || eligibleSuccessCount === "0" || !hasSelectedTerminal || value.reason !== null))
    || (value.status !== "observed" && value.reason === null)
    || (value.status === "observed" && !hasJoinedProcess)
    || (value.status !== "observed" && hasPartialJoinedProcess)
    || (value.status === "observed" && (predicateArtifactCount === "0" || value.eventArtifactRefIds.length === 0))
    || new Set(value.eventArtifactRefIds).size !== value.eventArtifactRefIds.length
    || (value.status !== "observed" && (predicateArtifactCount !== "0" || value.eventArtifactRefIds.length !== 0))
    || (value.status === "missing" && !missingReasons.has(value.reason as string))
    || (value.status === "invalid" && !invalidReasons.has(value.reason as string))
    || (value.reason === "no-successful-dry-run" && (!hasSelection || eligibleSuccessCount !== "0" || hasSelectedTerminal))
    || (value.reason === "window-selection-capability-invalid" && hasSelection)
    || (value.reason !== null && value.reason !== "no-successful-dry-run"
      && value.reason !== "window-selection-capability-invalid"
      && (!hasSelection || eligibleSuccessCount === "0" || !hasSelectedTerminal))) {
    throw new TypeError("terminal phase Six-Step selection mismatch");
  }
}

export function decodeTerminalSelectionManifestV1(value: TerminalSelectionCodecInput): TerminalSelectionManifestV1 {
  const decoded = terminalManifestSchema.decode(parse(value));
  validateTerminalSixStep(decoded.sixStep);
  const { manifestRoot: _root, ...core } = decoded;
  const exactCore = terminalManifestCoreSchema.decode(core);
  if (decoded.manifestRoot !== hashDomain("aloha/production-terminal-phase-manifest/v1", exactCore as unknown as CanonicalJson)) {
    throw new TypeError("terminal phase manifest root mismatch");
  }
  return decoded;
}

function appendRecordId(value: Infer<typeof durableAppendSchema>): Hash {
  return hashDomain("aloha/searcher-production-six-step-durable-append/v1", value as unknown as CanonicalJson);
}

export function decodeTerminalSelectionProcessEvidenceV1(value: TerminalSelectionCodecInput): TerminalSelectionProcessEvidenceV1 {
  const decoded = processEvidenceSchema.decode(parse(value));
  const { evidenceRoot: _root, ...core } = decoded;
  const exactCore = processEvidenceCoreSchema.decode(core);
  if (decoded.evidenceRoot !== hashDomain("aloha/searcher-production-six-step-process-evidence/v1", exactCore as unknown as CanonicalJson)
    || decoded.stage12Root !== hashDomain("aloha/searcher-production-evidence-stage12/v1", decoded.stage12 as unknown as CanonicalJson)
    || decoded.sixStepLineageRoot !== hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
      stage12Root: decoded.stage12Root,
      stage36Root: decoded.traceRoot,
    })
    || decoded.runtimeFactsRoot !== hashDomain("aloha/searcher-production-six-step-runtime-facts/v1", decoded.runtimeFacts as unknown as CanonicalJson)
    || decoded.producerSchedulerJoinRoot !== hashDomain("aloha/searcher-production-six-step-producer-scheduler-join/v1", decoded.producerSchedulerJoin as unknown as CanonicalJson)
    || decoded.runtimeAnchorRoot !== hashDomain("aloha/searcher-production-six-step-runtime-anchor/v1", decoded.runtimeAnchor as unknown as CanonicalJson)
    || decoded.durableAppendRecordId !== appendRecordId(decoded.durableAppend)
    || decoded.producerTerminalDurableAppendRecordId !== appendRecordId(decoded.producerTerminalDurableAppend)) {
    throw new TypeError("selected process evidence root mismatch");
  }
  return decoded;
}

export function encodeTerminalSelectionFactV1(value: TerminalSelectionFactV1): Uint8Array {
  return encodeCanonicalBytes(terminalSelectionFactSchema.decode(value));
}

export function encodeRawTerminalSelectionObservationV1(value: RawTerminalSelectionObservationV1): Uint8Array {
  return encodeCanonicalBytes(decodeRawTerminalSelectionObservationV1(value));
}

export function terminalSelectionProcessAnchorRoot(value: TerminalSelectionProcessEvidenceV1): Hash {
  return hashDomain("aloha/production-terminal-phase-process-anchor/v1", {
    bootId: value.runtimeAnchor.bootId,
    invocationId: value.runtimeAnchor.invocationId,
    logDevice: value.runtimeAnchor.logDevice,
    logInode: value.runtimeAnchor.logInode,
    pid: value.runtimeAnchor.pid,
    processStartTicks: value.runtimeAnchor.processStartTicks,
  });
}

export function terminalSelectionRuntimeAnchorRoot(value: TerminalSelectionProcessEvidenceV1): Hash {
  return hashDomain("aloha/production-terminal-phase-runtime-anchor/v1", value.runtimeAnchor as unknown as CanonicalJson);
}
