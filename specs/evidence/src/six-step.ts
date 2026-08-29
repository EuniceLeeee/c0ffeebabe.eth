import {
  arraySchema,
  canonicalObjectSchema,
  decodeCanonicalJson,
  defineSchema,
  defineSchemaManifest,
  encodeCanonicalBytes,
  enumSchema,
  hashDomain,
  hashSchema,
  literalSchema,
  nonEmptyStringSchema,
  objectSchema,
  readOwnEnumerableDataProperty,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import { CORE_SCHEMA_MANIFESTS, type SourceAnchor } from "../../core-envelope/src/index.ts";

export type SixStepCodecInput = string | Uint8Array | object;
export type SixStepStageId = "universe_instance" | "edge_ready_generation" | "planner_consumption" | "current_source_exact" | "execution_program" | "final_simulation";

export const SIX_STEP_STAGE_IDS = Object.freeze([
  "universe_instance", "edge_ready_generation", "planner_consumption",
  "current_source_exact", "execution_program", "final_simulation",
] as const);

const witnessSchema = objectSchema({ artifactRefId: hashSchema, contentRoot: hashSchema });
const witnessContentSchema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-evidence-witness"),
  stageId: enumSchema(SIX_STEP_STAGE_IDS), role: nonEmptyStringSchema, payload: canonicalObjectSchema,
});
const stage1Schema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-stage-facts"), stageId: literalSchema("universe_instance"),
  candidatePartition: witnessSchema, instancePublication: witnessSchema, identityProof: witnessSchema, sourceCoverage: witnessSchema,
});
const stage2Schema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-stage-facts"), stageId: literalSchema("edge_ready_generation"),
  instancePublication: witnessSchema, edge: witnessSchema, coverage: witnessSchema,
  promotionRevision: nonEmptyStringSchema, generationId: nonEmptyStringSchema,
  attestationMode: enumSchema(["fresh", "memo-reuse"] as const), memoReuseProof: witnessSchema,
});
const routeBindingSchema = objectSchema({
  edgeId: hashSchema, instanceKey: nonEmptyStringSchema, stage1EventId: hashSchema,
  stage2EventId: hashSchema, instancePublicationRoot: hashSchema,
});
const nativeBoundaryRecordSchema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-native-boundary-record"),
  stageId: enumSchema(SIX_STEP_STAGE_IDS), role: enumSchema(["raw-boundary", "native-log"] as const), payload: canonicalObjectSchema,
});
const stage3Schema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-stage-facts"), stageId: literalSchema("planner_consumption"),
  orderedInstanceBindings: arraySchema(routeBindingSchema), orderedInstanceBindingsRoot: hashSchema,
  routeSet: witnessSchema, coarseProjection: witnessSchema, admissionReceipt: witnessSchema,
  admissionClass: enumSchema(["ranked", "bounded-unranked"] as const),
});
const stage4Schema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-stage-facts"), stageId: literalSchema("current_source_exact"),
  currentSource: CORE_SCHEMA_MANIFESTS.sourceAnchor.schema, exactOutput: witnessSchema, fallback: literalSchema(false),
});
const stage5Schema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-stage-facts"), stageId: literalSchema("execution_program"),
  program: witnessSchema, callerMode: nonEmptyStringSchema, preCalls: witnessSchema,
  observationPairs: witnessSchema, actionOwner: witnessSchema, fallback: literalSchema(false),
});
const stage6Schema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-stage-facts"), stageId: literalSchema("final_simulation"),
  finalSimulationReceipt: witnessSchema, simulationSourceAnchor: CORE_SCHEMA_MANIFESTS.sourceAnchor.schema,
  economicReceipt: witnessSchema, safetyReceipt: witnessSchema, dryRun: literalSchema(true),
});

type StageFactsUnion = Infer<typeof stage1Schema> | Infer<typeof stage2Schema> | Infer<typeof stage3Schema> | Infer<typeof stage4Schema> | Infer<typeof stage5Schema> | Infer<typeof stage6Schema>;
const stageFactsSchema = defineSchema<StageFactsUnion>(
  { kind: "union", variants: [stage1Schema.descriptor, stage2Schema.descriptor, stage3Schema.descriptor, stage4Schema.descriptor, stage5Schema.descriptor, stage6Schema.descriptor] },
  (value, path = "$") => {
    const stageId = readOwnEnumerableDataProperty(value, "stageId", path);
    switch (stageId) {
      case "universe_instance": return stage1Schema.decode(value, path);
      case "edge_ready_generation": return stage2Schema.decode(value, path);
      case "planner_consumption": return stage3Schema.decode(value, path);
      case "current_source_exact": return stage4Schema.decode(value, path);
      case "execution_program": return stage5Schema.decode(value, path);
      case "final_simulation": return stage6Schema.decode(value, path);
      default: throw new TypeError(`unknown six-step stageId at ${path}.stageId`);
    }
  },
);
const stageInputSchema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-stage-input"), stageId: enumSchema(SIX_STEP_STAGE_IDS),
  rawBoundaryArtifactRefId: hashSchema, orderedWitnessArtifactRefIds: arraySchema(hashSchema), parentEventIds: arraySchema(hashSchema),
});
const eventFactSchema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.six-step-event-fact"),
  eventArtifactRefId: hashSchema, semanticArtifactRefId: hashSchema, productionReceiptArtifactRefId: hashSchema,
});

export type SixStepStageFactsV1 = Infer<typeof stageFactsSchema>;
export type SixStepStageInputV1 = Infer<typeof stageInputSchema>;
export type SixStepNativeBoundaryRecordV1 = Infer<typeof nativeBoundaryRecordSchema>;
export type SixStepEventFactV1 = Infer<typeof eventFactSchema>;
export type SixStepRouteBindingV1 = Infer<typeof routeBindingSchema>;
export type SixStepSourceAnchorV1 = SourceAnchor;
export type SixStepEvidenceWitnessV1 = Infer<typeof witnessSchema>;
export type SixStepWitnessContentV1 = Infer<typeof witnessContentSchema>;

export const SIX_STEP_SCHEMA_MANIFESTS = Object.freeze({
  witness: defineSchemaManifest("aloha.six-step-evidence-witness", "1.0.0", witnessSchema),
  witnessContent: defineSchemaManifest("aloha.six-step-witness-content", "1.0.0", witnessContentSchema),
  stageFacts: defineSchemaManifest("aloha.six-step-stage-facts", "1.0.0", stageFactsSchema),
  stageInput: defineSchemaManifest("aloha.six-step-stage-input", "1.0.0", stageInputSchema),
  nativeBoundaryRecord: defineSchemaManifest("aloha.six-step-native-boundary-record", "1.0.0", nativeBoundaryRecordSchema),
  eventFact: defineSchemaManifest("aloha.six-step-event-fact", "1.0.0", eventFactSchema),
});

function parse(value: SixStepCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}
export function decodeSixStepStageFacts(value: SixStepCodecInput): SixStepStageFactsV1 { return stageFactsSchema.decode(parse(value)); }
export function decodeSixStepStageInput(value: SixStepCodecInput): SixStepStageInputV1 { return stageInputSchema.decode(parse(value)); }
export function decodeSixStepNativeBoundaryRecord(value: SixStepCodecInput): SixStepNativeBoundaryRecordV1 { return nativeBoundaryRecordSchema.decode(parse(value)); }
export function decodeSixStepEventFact(value: SixStepCodecInput): SixStepEventFactV1 { return eventFactSchema.decode(parse(value)); }
export function decodeSixStepWitness(value: SixStepCodecInput): SixStepEvidenceWitnessV1 { return witnessSchema.decode(parse(value)); }
export function decodeSixStepWitnessContent(value: SixStepCodecInput): SixStepWitnessContentV1 { return witnessContentSchema.decode(parse(value)); }
export function encodeSixStepStageFacts(value: SixStepStageFactsV1): Uint8Array { return encodeCanonicalBytes(stageFactsSchema.decode(value)); }
export function encodeSixStepStageInput(value: SixStepStageInputV1): Uint8Array { return encodeCanonicalBytes(stageInputSchema.decode(value)); }
export function encodeSixStepEventFact(value: SixStepEventFactV1): Uint8Array { return encodeCanonicalBytes(eventFactSchema.decode(value)); }
export function encodeSixStepWitness(value: SixStepEvidenceWitnessV1): Uint8Array { return encodeCanonicalBytes(witnessSchema.decode(value)); }
export function encodeSixStepWitnessContent(value: SixStepWitnessContentV1): Uint8Array { return encodeCanonicalBytes(witnessContentSchema.decode(value)); }
export function hashSixStepWitnessContentRoot(value: SixStepWitnessContentV1): Hash { return hashDomain("aloha/six-step/witness-content/v1", witnessContentSchema.decode(value)); }
export function hashOrderedInstanceBindingsRoot(bindings: readonly SixStepRouteBindingV1[]): Hash { return hashDomain("aloha/six-step/ordered-instance-bindings/v1", bindings); }
export function stageFactsSchemaRef(): { readonly id: string; readonly version: string; readonly schemaHash: Hash } {
  return { id: SIX_STEP_SCHEMA_MANIFESTS.stageFacts.id, version: SIX_STEP_SCHEMA_MANIFESTS.stageFacts.version, schemaHash: SIX_STEP_SCHEMA_MANIFESTS.stageFacts.schemaHash };
}
export function stageInputSchemaRef(): { readonly id: string; readonly version: string; readonly schemaHash: Hash } {
  return { id: SIX_STEP_SCHEMA_MANIFESTS.stageInput.id, version: SIX_STEP_SCHEMA_MANIFESTS.stageInput.version, schemaHash: SIX_STEP_SCHEMA_MANIFESTS.stageInput.schemaHash };
}
