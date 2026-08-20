import {
  decodeCanonicalJson,
  defineSchema,
  defineSchemaManifest,
  enumSchema,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  arraySchema,
  canonicalObjectSchema,
  canonicalJsonSchema,
  decimalStringSchema,
  gitSha40Schema,
  hashSchema,
  literalSchema,
  nullableSchema,
  nonEmptyStringSchema,
  objectSchema,
  readOwnEnumerableDataProperty,
  refineSchema,
  semVerSchema,
  type Infer,
  type CanonicalJson,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  CORE_SCHEMA_MANIFESTS,
  STABLE_REASON_CODES,
  type DecimalString,
  type GitSha40,
  type ProcessAnchorV1,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
  type StableReasonCode,
} from "../../core-envelope/src/index.ts";

export type { CanonicalJson, CanonicalJsonObject, Hash } from "../../../packages/canonical-codec/src/index.ts";
export type { ProcessAnchorV1, ReadOnlyArtifactRefV1, SchemaRef, StableReasonCode } from "../../core-envelope/src/index.ts";

const STAGE_IDS = [
  "universe_instance",
  "edge_ready_generation",
  "planner_consumption",
  "current_source_exact",
  "execution_program",
  "final_simulation",
] as const;

export type EvidenceSourceV1 = Infer<typeof sourceSchema>;
export type EvidenceRuntimeV1 = Infer<typeof runtimeSchema>;
export type EvidenceArtifactLineageV1 = Infer<typeof lineageSchema>;
export type EvidenceScopeV1 = Infer<typeof scopeSchema>;
export type EvidenceStageV1 = Infer<typeof stageStructureSchema>;
export type EvidenceStageId = (typeof STAGE_IDS)[number];
export type CapabilityRefV1 = Infer<typeof capabilitySchema>;
export type EvidenceLatencyV1 = Infer<typeof latencySchema>;
export type EvidenceExtensionV1 = Infer<typeof extensionSchema>;
export type EvidenceEventV1 = Infer<typeof eventStructuralSchema>;
export type EvidenceOutcome = EvidenceEventV1["outcome"];

export type EvidenceCodecInput = string | Uint8Array | object;

const STAGES: readonly EvidenceStageId[] = STAGE_IDS;

function parseInput(value: EvidenceCodecInput): unknown {
  if (typeof value === "string") {
    return decodeCanonicalJson(value);
  }
  if (ArrayBuffer.isView(value)) {
    return decodeCanonicalJson(value as Uint8Array);
  }
  return value;
}

/* Structural fields are defined once as executable schemas. The parser
 * functions below only apply DAG, stage, ordering, and hash refinements. */
const schemaRefSchema = CORE_SCHEMA_MANIFESTS.schemaRef.schema;
const artifactRefSchema = CORE_SCHEMA_MANIFESTS.readOnlyArtifactRef.schema;
const processAnchorSchema = CORE_SCHEMA_MANIFESTS.processAnchor.schema;

const sourceSchema = objectSchema({
  systemId: nonEmptyStringSchema,
  emitterKind: enumSchema(["native", "read-only-adapter"] as const),
  emitterCodeHash: hashSchema,
  rawBoundaryArtifactRef: artifactRefSchema,
});

const runtimeSchema = objectSchema({
  commitSha: gitSha40Schema,
  executableHash: hashSchema,
  deploymentManifestHash: hashSchema,
  serviceIdentityHash: hashSchema,
  pid: decimalStringSchema,
  processStartTicks: decimalStringSchema,
  bootIdHash: hashSchema,
  logRangeArtifactRefId: hashSchema,
});

const lineageSchema = objectSchema({
  inputArtifactIds: arraySchema(hashSchema),
  outputArtifactId: hashSchema,
  productionReceiptId: hashSchema,
});

const builderRunScopeSchema = objectSchema({
  kind: literalSchema("builder-run"),
  builderRunId: nonEmptyStringSchema,
  producerSessionId: literalSchema(null),
  generationId: literalSchema(null),
  generationRefreshPolicyHash: hashSchema,
});
const readyGenerationScopeSchema = objectSchema({
  kind: literalSchema("ready-generation"),
  builderRunId: nonEmptyStringSchema,
  producerSessionId: literalSchema(null),
  generationId: nonEmptyStringSchema,
  generationRefreshPolicyHash: hashSchema,
});
const producerSessionScopeSchema = objectSchema({
  kind: literalSchema("producer-session"),
  builderRunId: nonEmptyStringSchema,
  producerSessionId: nonEmptyStringSchema,
  generationId: nonEmptyStringSchema,
  generationRefreshPolicyHash: hashSchema,
});
const scopeSchema = defineSchema(
  {
    kind: "union",
    variants: [
      builderRunScopeSchema.descriptor,
      readyGenerationScopeSchema.descriptor,
      producerSessionScopeSchema.descriptor,
    ],
  },
  (value, path = "$") => {
    switch (readOwnEnumerableDataProperty(value, "kind", path)) {
      case "builder-run": return builderRunScopeSchema.decode(value, path);
      case "ready-generation": return readyGenerationScopeSchema.decode(value, path);
      case "producer-session": return producerSessionScopeSchema.decode(value, path);
      default: throw new TypeError(`unknown evidence scope kind at ${path}.kind`);
    }
  },
);

const stageStructureSchema = objectSchema({
  ordinal: enumSchema([1, 2, 3, 4, 5, 6] as const),
  id: enumSchema(STAGE_IDS),
  version: literalSchema(1),
});

const capabilitySchema = objectSchema({
  capabilityId: nonEmptyStringSchema,
  version: semVerSchema,
  schemaHash: hashSchema,
  interpreterHash: hashSchema,
});

const cutoffSchema = objectSchema({
  number: decimalStringSchema,
  hash: hashSchema,
  stateRoot: hashSchema,
});

const latencySchema = objectSchema({
  startedMonotonicNs: decimalStringSchema,
  finishedMonotonicNs: decimalStringSchema,
  durationUs: decimalStringSchema,
});

const extensionSchema = objectSchema({
  schema: schemaRefSchema,
  value: canonicalJsonSchema,
});

const eventStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.fact-evidence-event"),
  eventId: hashSchema,
  source: sourceSchema,
  runtime: runtimeSchema,
  artifactLineage: lineageSchema,
  scope: scopeSchema,
  correlationId: nonEmptyStringSchema,
  runSequence: decimalStringSchema,
  cutoff: cutoffSchema,
  definitionCatalogRoot: hashSchema,
  strategyCatalogRoot: nullableSchema(hashSchema),
  instanceCatalogRoot: nullableSchema(hashSchema),
  graphRoot: nullableSchema(hashSchema),
  familyId: nonEmptyStringSchema,
  candidateKey: nonEmptyStringSchema,
  familyDefinitionHash: hashSchema,
  capabilities: arraySchema(capabilitySchema),
  capabilitySetHash: hashSchema,
  instanceKey: nullableSchema(nonEmptyStringSchema),
  stage: stageStructureSchema,
  parentEventIds: arraySchema(hashSchema),
  parentOutputHashes: arraySchema(hashSchema),
  inputSchema: schemaRefSchema,
  inputs: canonicalObjectSchema,
  inputHash: hashSchema,
  factSchema: schemaRefSchema,
  facts: canonicalObjectSchema,
  outputHash: hashSchema,
  outcome: enumSchema([
    "verified",
    "success",
    "chain_proven_rejected",
    "retryable",
    "invalid_program",
    "policy_rejected",
    "simulation_reverted",
    "failed_closed",
  ] as const),
  reasonCode: nullableSchema(enumSchema(STABLE_REASON_CODES)),
  latency: latencySchema,
  extensions: arraySchema(extensionSchema),
});

const eventRefinementSpecDigest = hashDomain(
  "aloha/schema-refinement-spec/v1",
  {
    id: "evidence.fact-event.refinement.v1",
    version: "1.0.0",
    rules: [
      "stage-ordinal-id-and-scope-match",
      "stage-roots-and-instance-key-match-lifecycle",
      "stage-parent-cardinality-is-exact",
      "success-and-failure-reason-codes-are-consistent",
      "capabilities-and-extensions-are-strictly-sorted",
      "capability-input-output-and-event-hashes-match",
      "finished-monotonic-time-not-before-started",
    ],
  },
);

const eventSchema = refineSchema(
  eventStructuralSchema,
  "evidence.fact-event.refinement.v1",
  eventRefinementSpecDigest,
  (value, path) => refineEvidenceEvent(value, path, true),
);

export const EVIDENCE_SCHEMA_MANIFESTS = Object.freeze({
  event: defineSchemaManifest("aloha.fact-evidence-event", "1.0.0", eventSchema),
});

const capabilitiesArraySchema = arraySchema(capabilitySchema);

function parseCapabilities(value: unknown, path = "$"): readonly CapabilityRefV1[] {
  const result = capabilitiesArraySchema.decode(value, path);
  const keys = result.map((entry) => encodeCanonicalJson(entry));
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] >= keys[index]) {
      throw new TypeError(`capabilities must be strictly sorted at ${path}`);
    }
  }
  return result;
}

function extensionKey(value: SchemaRef): string {
  return encodeCanonicalJson(value);
}

function parseEvent(
  value: unknown,
  verifyIdentity = true,
  path = "$",
): EvidenceEventV1 {
  const event = eventStructuralSchema.decode(value, path);
  return refineEvidenceEvent(event, path, verifyIdentity);
}

function refineEvidenceEvent(
  event: EvidenceEventV1,
  path: string,
  verifyIdentity: boolean,
): EvidenceEventV1 {
  validateStageScopeBindings(event);
  if (STAGES[event.stage.ordinal - 1] !== event.stage.id) {
    throw new TypeError("stage ordinal/id mismatch");
  }
  if (event.parentEventIds.length !== event.parentOutputHashes.length) {
    throw new TypeError("parentEventIds and parentOutputHashes must have equal lengths");
  }
  if (new Set(event.parentEventIds).size !== event.parentEventIds.length) {
    throw new TypeError("duplicate parent event ID");
  }
  let previousExtension: string | null = null;
  for (const extension of event.extensions) {
    const key = extensionKey(extension.schema);
    if (previousExtension !== null && key <= previousExtension) {
      throw new TypeError("extensions must be strictly sorted by SchemaRef");
    }
    previousExtension = key;
  }
  const capabilitySetHash = recomputeCapabilitySetHash(event.capabilities);
  if (event.capabilitySetHash !== capabilitySetHash) {
    throw new TypeError("capabilitySetHash does not match capabilities");
  }
  const inputHash = recomputeStageInputHash(event);
  if (event.inputHash !== inputHash) {
    throw new TypeError("inputHash does not match stage input");
  }
  const outputHash = recomputeStageOutputHash(event);
  if (event.outputHash !== outputHash) {
    throw new TypeError("outputHash does not match stage output");
  }
  const eventId = recomputeEvidenceEventIdUnchecked(event);
  if (verifyIdentity && event.eventId !== eventId) {
    throw new TypeError("eventId does not match evidence envelope");
  }
  return event;
}

function validateStageScopeBindings(event: EvidenceEventV1): void {
  const ordinal = event.stage.ordinal;
  if (
    ordinal === 1 &&
    event.outcome !== "verified" &&
    event.outcome !== "chain_proven_rejected" &&
    event.outcome !== "retryable" &&
    event.outcome !== "invalid_program"
  ) {
    throw new TypeError("stage 1 outcome is outside its exact outcome set");
  }
  const expectedScope = ordinal === 1
    ? "builder-run"
    : ordinal === 2
      ? "ready-generation"
      : "producer-session";
  if (event.scope.kind !== expectedScope) {
    throw new TypeError("stage and scope kind are inconsistent");
  }
  if (ordinal <= 2 && event.strategyCatalogRoot !== null) {
    throw new TypeError("strategyCatalogRoot must be null for stages 1 and 2");
  }
  if (ordinal >= 3 && event.strategyCatalogRoot === null) {
    throw new TypeError("stages 3 through 6 require strategyCatalogRoot");
  }
  if (ordinal === 1 && (event.instanceCatalogRoot !== null || event.graphRoot !== null)) {
    throw new TypeError("stage 1 cannot carry instanceCatalogRoot or graphRoot");
  }
  if (ordinal >= 2 && (event.instanceCatalogRoot === null || event.graphRoot === null)) {
    throw new TypeError("stages 2 through 6 require instanceCatalogRoot and graphRoot");
  }
  if (event.outcome === "verified" && event.instanceKey === null) {
    throw new TypeError("verified events require instanceKey");
  }
  if (event.outcome === "success" && event.instanceKey === null) {
    throw new TypeError("successful events require instanceKey");
  }
  if (ordinal >= 2 && event.instanceKey === null) {
    throw new TypeError("stages 2 through 6 require instanceKey");
  }
  if ((event.outcome === "verified" || event.outcome === "success") && event.reasonCode !== null) {
    throw new TypeError("successful outcomes require null reasonCode");
  }
  if (event.outcome !== "verified" && event.outcome !== "success" && event.reasonCode === null) {
    throw new TypeError("non-success outcomes require stable reasonCode");
  }
  if (ordinal === 1 && event.outcome === "success") {
    throw new TypeError("stage 1 success must use outcome verified");
  }
  if (ordinal >= 2 && event.outcome === "verified") {
    throw new TypeError("stages 2 through 6 success must use outcome success");
  }
  if (ordinal === 1 && event.parentEventIds.length !== 0) {
    throw new TypeError("stage 1 cannot have parent events");
  }
  if (ordinal === 2 && event.parentEventIds.length !== 1) {
    throw new TypeError("stage 2 must have exactly one stage 1 parent");
  }
  if (ordinal === 3 && event.parentEventIds.length < 1) {
    throw new TypeError("stage 3 must fan in at least one parent");
  }
  if (ordinal >= 4 && event.parentEventIds.length !== 1) {
    throw new TypeError("stages 4 through 6 must have one linear parent");
  }
  if (BigInt(event.latency.finishedMonotonicNs) < BigInt(event.latency.startedMonotonicNs)) {
    throw new TypeError("finishedMonotonicNs precedes startedMonotonicNs");
  }
}

export function recomputeCapabilitySetHash(
  capabilities: readonly CapabilityRefV1[],
): Hash {
  const parsed = parseCapabilities(capabilities);
  return hashDomain("aloha/capability-set/v1", parsed);
}

function stageInputPayload(event: EvidenceEventV1): CanonicalJsonObject {
  return {
    stageId: event.stage.id,
    inputSchema: event.inputSchema,
    inputs: event.inputs,
  };
}

export function recomputeStageInputHash(event: EvidenceEventV1): Hash {
  return hashDomain("aloha/stage-input/v1", stageInputPayload(event));
}

function stageOutputPayload(event: EvidenceEventV1): CanonicalJsonObject {
  return {
    stageId: event.stage.id,
    factSchema: event.factSchema,
    facts: event.facts,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
  };
}

export function recomputeStageOutputHash(event: EvidenceEventV1): Hash {
  return hashDomain("aloha/stage-output/v1", stageOutputPayload(event));
}

function evidenceEventPayload(event: EvidenceEventV1): CanonicalJsonObject {
  const { eventId: _eventId, ...payload } = event;
  return payload;
}

function recomputeEvidenceEventIdUnchecked(event: EvidenceEventV1): Hash {
  return hashDomain("aloha/evidence-event/v1", evidenceEventPayload(event));
}

export function recomputeEvidenceEventId(value: EvidenceEventV1): Hash {
  return recomputeEvidenceEventIdUnchecked(parseEvent(value, false));
}

export function decodeEvidenceEvent(value: EvidenceCodecInput): EvidenceEventV1 {
  return parseEvent(parseInput(value));
}

export function encodeEvidenceEvent(value: EvidenceEventV1): Uint8Array {
  return encodeCanonicalBytes(parseEvent(value));
}

export type EvidenceEventDraft = Omit<
  EvidenceEventV1,
  "eventId" | "capabilitySetHash" | "inputHash" | "outputHash"
> & {
  readonly eventId?: Hash;
  readonly capabilitySetHash?: Hash;
  readonly inputHash?: Hash;
  readonly outputHash?: Hash;
};

export function createEvidenceEvent(draft: EvidenceEventDraft): EvidenceEventV1 {
  const intermediate = {
    ...draft,
    eventId: "0x" + "0".repeat(64),
    capabilitySetHash: "0x" + "0".repeat(64),
    inputHash: "0x" + "0".repeat(64),
    outputHash: "0x" + "0".repeat(64),
  } as EvidenceEventV1;
  const withHashes = {
    ...intermediate,
    capabilitySetHash: recomputeCapabilitySetHash(intermediate.capabilities),
    inputHash: recomputeStageInputHash(intermediate),
    outputHash: recomputeStageOutputHash(intermediate),
  } as EvidenceEventV1;
  const eventId = recomputeEvidenceEventIdUnchecked(withHashes);
  return parseEvent({ ...withHashes, eventId });
}

export function assertEvidenceEventMatchesReceipt(
  event: EvidenceEventV1,
  receipt: {
    readonly receiptId: Hash;
    readonly artifactId: Hash;
    readonly producer: ProcessAnchorV1;
    readonly logRangeArtifactRef: ReadOnlyArtifactRefV1;
    readonly rawBoundaryArtifactRef: ReadOnlyArtifactRefV1;
    readonly startedMonotonicNs: string;
    readonly finishedMonotonicNs: string;
    readonly durationUs: string;
  },
): void {
  if (event.artifactLineage.productionReceiptId !== receipt.receiptId) {
    throw new TypeError("event productionReceiptId does not match receipt");
  }
  if (event.artifactLineage.outputArtifactId !== receipt.artifactId) {
    throw new TypeError("event output artifact does not match receipt artifact");
  }
  const producer = receipt.producer;
  // The core contract intentionally binds both native and read-only-adapter
  // emitters to the producing process' system identity. An adapter that runs
  // elsewhere needs a future explicit adapter-receipt schema; it cannot weaken
  // this binding by merely changing emitterKind.
  if (event.source.systemId !== producer.systemId) {
    throw new TypeError("event source systemId does not match receipt producer");
  }
  const runtime: EvidenceRuntimeV1 = {
    commitSha: producer.commitSha,
    executableHash: producer.executableHash,
    deploymentManifestHash: producer.deploymentManifestHash,
    serviceIdentityHash: producer.serviceIdentityHash,
    pid: producer.pid,
    processStartTicks: producer.processStartTicks,
    bootIdHash: producer.bootIdHash,
    logRangeArtifactRefId: receipt.logRangeArtifactRef.artifactRefId,
  };
  if (encodeCanonicalJson(event.runtime) !== encodeCanonicalJson(runtime)) {
    throw new TypeError("event runtime does not match production receipt");
  }
  if (encodeCanonicalJson(event.source.rawBoundaryArtifactRef) !== encodeCanonicalJson(receipt.rawBoundaryArtifactRef)) {
    throw new TypeError("event source boundary ref does not match receipt");
  }
  const expectedLatency = {
    startedMonotonicNs: receipt.startedMonotonicNs,
    finishedMonotonicNs: receipt.finishedMonotonicNs,
    durationUs: receipt.durationUs,
  };
  if (encodeCanonicalJson(event.latency) !== encodeCanonicalJson(expectedLatency)) {
    throw new TypeError("event latency does not match production receipt");
  }
}

export const recomputeEventId = recomputeEvidenceEventId;
export const decode = decodeEvidenceEvent;
export const encode = encodeEvidenceEvent;
