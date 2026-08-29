import {
  assertExactKeys,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashDomain,
  readOwnEnumerableDataProperty,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeProductionReceipt,
  decodeSemanticArtifact,
  type ProcessAnchorV1,
  type ProductionReceiptV1,
  type ReadOnlyArtifactRefV1,
  type SemanticArtifactV1,
  type SchemaRef,
  type SourceAnchor,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createEvidenceEvent,
  decodeEvidenceEvent,
  encodeEvidenceEvent,
  type CapabilityRefV1,
  type EvidenceEventDraft,
  type EvidenceEventV1,
  type EvidenceExtensionV1,
  type EvidenceLatencyV1,
  type EvidenceOutcome,
  type EvidenceScopeV1,
  type EvidenceStageV1,
  type EvidenceStageId,
} from "../../../specs/evidence/src/index.ts";

/**
 * An append receipt is part of the durable fact.  The port implementation owns
 * the actual file/database write; the emitter only accepts an acknowledgement
 * that the bytes were appended and fsync-sealed in the requested sequence.
 */
export interface EvidenceAppendReceiptV1 {
  readonly sequence: string;
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly offsetStart: string;
  readonly offsetEnd: string;
  readonly fsynced: true;
}

export interface EvidenceAppendRequestV1 {
  readonly sequence: string;
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly bytes: Uint8Array;
}

/** The only state-changing capability owned by this package. */
export interface EvidenceAppendPortV1 {
  appendFsyncMonotonic(
    request: EvidenceAppendRequestV1,
  ): Promise<EvidenceAppendReceiptV1>;
}

export interface EvidenceEmitterOptionsV1 {
  readonly append: EvidenceAppendPortV1;
  readonly emitterKind: "native" | "read-only-adapter";
  readonly emitterCodeHash: Hash;
  readonly initialSequence?: string;
}

export interface EvidenceBoundaryParentV1 {
  readonly event: EvidenceEventV1;
}

/**
 * This is deliberately a boundary object, not a business DTO.  The two core
 * objects must already have been created and content-addressed by their owning
 * production subsystem.  The emitter does not create candidates, graph
 * entries, quotes, programs, simulations, or a semantic outcome.
 *
 * `outcome` is the already-sealed semantic outcome of the boundary object.  It
 * is not called `verdict` and the exact parser rejects the common producer
 * verdict/expected-success fields so a caller cannot smuggle a second claim
 * channel into the emitter.
 */
export interface EvidenceBoundaryObjectV1 {
  readonly semanticArtifact: SemanticArtifactV1;
  readonly productionReceipt: ProductionReceiptV1;
  readonly scope: EvidenceScopeV1;
  readonly correlationId: string;
  readonly runSequence: string;
  readonly cutoff: Omit<SourceAnchor, "chainId">;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash | null;
  readonly instanceCatalogRoot: Hash | null;
  readonly graphRoot: Hash | null;
  readonly familyId: string;
  readonly candidateKey: string;
  readonly familyDefinitionHash: Hash;
  readonly capabilities: readonly CapabilityRefV1[];
  readonly instanceKey: string | null;
  readonly stage: EvidenceStageV1;
  readonly inputSchema: SchemaRef;
  readonly inputs: CanonicalJsonObject;
  readonly factSchema: SchemaRef;
  readonly facts: CanonicalJsonObject;
  readonly outcome: EvidenceOutcome;
  readonly reasonCode: EvidenceEventV1["reasonCode"];
  readonly parentEvents: readonly EvidenceBoundaryParentV1[];
  readonly extensions: readonly EvidenceExtensionV1[];
}

export interface EvidenceEmissionV1 {
  readonly event: EvidenceEventV1;
  readonly bytes: Uint8Array;
  readonly contentSha256: Hash;
  readonly append: EvidenceAppendReceiptV1;
}

export class EvidenceWriteFailedError extends Error {
  readonly code = "evidence-write-failed" as const;

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EvidenceWriteFailedError";
  }
}

const BOUNDARY_KEYS = [
  "semanticArtifact",
  "productionReceipt",
  "scope",
  "correlationId",
  "runSequence",
  "cutoff",
  "definitionCatalogRoot",
  "strategyCatalogRoot",
  "instanceCatalogRoot",
  "graphRoot",
  "familyId",
  "candidateKey",
  "familyDefinitionHash",
  "capabilities",
  "instanceKey",
  "stage",
  "inputSchema",
  "inputs",
  "factSchema",
  "facts",
  "outcome",
  "reasonCode",
  "parentEvents",
  "extensions",
] as const;

const FORBIDDEN_CLAIM_KEYS = new Set([
  "producerVerdict",
  "expectedVerdict",
  "expectedSuccess",
  "checks",
  "passed",
  "verdict",
]);

function parseCanonicalInput(value: unknown): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function read<T>(value: unknown, key: string, path: string): T {
  return readOwnEnumerableDataProperty(value, key, path) as T;
}

function copyExactArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || typeof length.value !== "number") {
    throw new TypeError(`${path} has no concrete length`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length.value + 1) throw new TypeError(`${path} must be dense`);
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${path}[${index}] must be an enumerable data property`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function rejectForbiddenClaimKeys(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError(`cyclic boundary claim at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new TypeError(`invalid array claim at ${path}[${index}]`);
        rejectForbiddenClaimKeys(descriptor.value, `${path}[${index}]`, seen);
      }
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`symbol claim field at ${path}`);
      if (FORBIDDEN_CLAIM_KEYS.has(key)) throw new TypeError(`producer claim field ${key} is not accepted at ${path}.${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError(`accessor claim field at ${path}.${key}`);
      rejectForbiddenClaimKeys(descriptor.value, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function parseBoundary(value: unknown): EvidenceBoundaryObjectV1 {
  const parsed = parseCanonicalInput(value);
  assertPlainObject(parsed, "$.boundary");
  assertExactKeys(parsed, BOUNDARY_KEYS, "$.boundary");
  const semanticArtifact = decodeSemanticArtifact(read(parsed, "semanticArtifact", "$.boundary"));
  const productionReceipt = decodeProductionReceipt(read(parsed, "productionReceipt", "$.boundary"));
  const parentValues = copyExactArray(read(parsed, "parentEvents", "$.boundary"), "$.boundary.parentEvents");
  const parentEvents = parentValues.map((parent, index) => {
    assertPlainObject(parent, `$.boundary.parentEvents[${index}]`);
    assertExactKeys(parent, ["event"], `$.boundary.parentEvents[${index}]`);
    return Object.freeze({ event: decodeEvidenceEventForEmitter(read(parent, "event", `$.boundary.parentEvents[${index}]`)) });
  });
  const boundary = {
    semanticArtifact,
    productionReceipt,
    scope: read(parsed, "scope", "$.boundary") as EvidenceScopeV1,
    correlationId: read(parsed, "correlationId", "$.boundary") as string,
    runSequence: read(parsed, "runSequence", "$.boundary") as string,
    cutoff: read(parsed, "cutoff", "$.boundary") as SourceAnchor,
    definitionCatalogRoot: read(parsed, "definitionCatalogRoot", "$.boundary") as Hash,
    strategyCatalogRoot: read(parsed, "strategyCatalogRoot", "$.boundary") as Hash | null,
    instanceCatalogRoot: read(parsed, "instanceCatalogRoot", "$.boundary") as Hash | null,
    graphRoot: read(parsed, "graphRoot", "$.boundary") as Hash | null,
    familyId: read(parsed, "familyId", "$.boundary") as string,
    candidateKey: read(parsed, "candidateKey", "$.boundary") as string,
    familyDefinitionHash: read(parsed, "familyDefinitionHash", "$.boundary") as Hash,
    capabilities: copyExactArray(read(parsed, "capabilities", "$.boundary"), "$.boundary.capabilities") as readonly CapabilityRefV1[],
    instanceKey: read(parsed, "instanceKey", "$.boundary") as string | null,
    stage: read(parsed, "stage", "$.boundary") as EvidenceStageV1,
    inputSchema: read(parsed, "inputSchema", "$.boundary") as SchemaRef,
    inputs: read(parsed, "inputs", "$.boundary") as CanonicalJsonObject,
    factSchema: read(parsed, "factSchema", "$.boundary") as SchemaRef,
    facts: read(parsed, "facts", "$.boundary") as CanonicalJsonObject,
    outcome: read(parsed, "outcome", "$.boundary") as EvidenceOutcome,
    reasonCode: read(parsed, "reasonCode", "$.boundary") as EvidenceEventV1["reasonCode"],
    parentEvents,
    extensions: copyExactArray(read(parsed, "extensions", "$.boundary"), "$.boundary.extensions") as readonly EvidenceExtensionV1[],
  } satisfies EvidenceBoundaryObjectV1;
  rejectForbiddenClaimKeys(boundary.inputs, "$.boundary.inputs");
  rejectForbiddenClaimKeys(boundary.facts, "$.boundary.facts");
  if (productionReceipt.artifactId !== semanticArtifact.artifactId) {
    throw new TypeError("production receipt does not bind semantic artifact");
  }
  if (semanticArtifact.canonicalPayloadHash !== hashStageOutput(boundary)) {
    throw new TypeError("semantic artifact canonicalPayloadHash does not bind stage facts");
  }
  return Object.freeze(boundary);
}

function decodeEvidenceEventForEmitter(value: unknown): EvidenceEventV1 {
  // A local import would create a second codec authority.  The public codec is
  // loaded once above through the function import below; this wrapper exists
  // solely to keep all parent decoding at the exact boundary.
  return decodeEvidenceEvent(value as object);
}

function hashStageOutput(boundary: Pick<EvidenceBoundaryObjectV1, "stage" | "factSchema" | "facts" | "outcome" | "reasonCode">): Hash {
  return hashDomain("aloha/stage-output/v1", {
    stageId: boundary.stage.id,
    factSchema: boundary.factSchema,
    facts: boundary.facts,
    outcome: boundary.outcome,
    reasonCode: boundary.reasonCode,
  });
}

function assertAppendReceipt(
  value: unknown,
  request: EvidenceAppendRequestV1,
  expectedSequence: bigint,
): EvidenceAppendReceiptV1 {
  assertPlainObject(value, "$.appendReceipt");
  assertExactKeys(value, ["sequence", "eventId", "contentSha256", "byteLength", "offsetStart", "offsetEnd", "fsynced"], "$.appendReceipt");
  const result = {
    sequence: read(value, "sequence", "$.appendReceipt") as string,
    eventId: read(value, "eventId", "$.appendReceipt") as Hash,
    contentSha256: read(value, "contentSha256", "$.appendReceipt") as Hash,
    byteLength: read(value, "byteLength", "$.appendReceipt") as string,
    offsetStart: read(value, "offsetStart", "$.appendReceipt") as string,
    offsetEnd: read(value, "offsetEnd", "$.appendReceipt") as string,
    fsynced: read(value, "fsynced", "$.appendReceipt") as true,
  } satisfies EvidenceAppendReceiptV1;
  if (result.fsynced !== true || result.eventId !== request.eventId || result.contentSha256 !== request.contentSha256) {
    throw new EvidenceWriteFailedError("append acknowledgement does not bind event bytes");
  }
  if (result.sequence !== expectedSequence.toString() || result.byteLength !== request.bytes.byteLength.toString()) {
    throw new EvidenceWriteFailedError("append acknowledgement sequence or length is not exact");
  }
  try {
    if (BigInt(result.offsetEnd) - BigInt(result.offsetStart) !== BigInt(result.byteLength)) {
      throw new EvidenceWriteFailedError("append acknowledgement offsets are not exact");
    }
  } catch (error) {
    if (error instanceof EvidenceWriteFailedError) throw error;
    throw new EvidenceWriteFailedError("append acknowledgement offsets are not decimal", { cause: error });
  }
  return Object.freeze(result);
}

function buildEvent(
  boundary: EvidenceBoundaryObjectV1,
  options: EvidenceEmitterOptionsV1,
): EvidenceEventV1 {
  const producer = boundary.productionReceipt.producer;
  const draft: EvidenceEventDraft = {
    schemaVersion: 1,
    kind: "aloha.fact-evidence-event",
    source: {
      systemId: producer.systemId,
      emitterKind: options.emitterKind,
      emitterCodeHash: options.emitterCodeHash,
      rawBoundaryArtifactRef: boundary.productionReceipt.rawBoundaryArtifactRef,
    },
    runtime: {
      commitSha: producer.commitSha,
      executableHash: producer.executableHash,
      deploymentManifestHash: producer.deploymentManifestHash,
      serviceIdentityHash: producer.serviceIdentityHash,
      pid: producer.pid,
      processStartTicks: producer.processStartTicks,
      bootIdHash: producer.bootIdHash,
      logRangeArtifactRefId: boundary.productionReceipt.logRangeArtifactRef.artifactRefId,
    },
    artifactLineage: {
      inputArtifactIds: boundary.semanticArtifact.inputArtifactIds,
      outputArtifactId: boundary.semanticArtifact.artifactId,
      productionReceiptId: boundary.productionReceipt.receiptId,
    },
    scope: boundary.scope,
    correlationId: boundary.correlationId,
    runSequence: boundary.runSequence,
    cutoff: boundary.cutoff,
    definitionCatalogRoot: boundary.definitionCatalogRoot,
    strategyCatalogRoot: boundary.strategyCatalogRoot,
    instanceCatalogRoot: boundary.instanceCatalogRoot,
    graphRoot: boundary.graphRoot,
    familyId: boundary.familyId,
    candidateKey: boundary.candidateKey,
    familyDefinitionHash: boundary.familyDefinitionHash,
    capabilities: boundary.capabilities,
    capabilitySetHash: hashDomain("aloha/capability-set/v1", boundary.capabilities),
    instanceKey: boundary.instanceKey,
    stage: boundary.stage,
    parentEventIds: boundary.parentEvents.map((parent) => parent.event.eventId),
    parentOutputHashes: boundary.parentEvents.map((parent) => parent.event.outputHash),
    inputSchema: boundary.inputSchema,
    inputs: boundary.inputs,
    inputHash: hashDomain("aloha/stage-input/v1", {
      stageId: boundary.stage.id,
      inputSchema: boundary.inputSchema,
      inputs: boundary.inputs,
    }),
    factSchema: boundary.factSchema,
    facts: boundary.facts,
    outputHash: hashStageOutput(boundary),
    outcome: boundary.outcome,
    reasonCode: boundary.reasonCode,
    latency: {
      startedMonotonicNs: boundary.productionReceipt.startedMonotonicNs,
      finishedMonotonicNs: boundary.productionReceipt.finishedMonotonicNs,
      durationUs: boundary.productionReceipt.durationUs,
    },
    extensions: boundary.extensions,
  };
  const event = createEvidenceEvent(draft);
  if (event.artifactLineage.outputArtifactId !== boundary.semanticArtifact.artifactId) {
    throw new EvidenceWriteFailedError("event output artifact binding changed while encoding");
  }
  return event;
}

export function encodeContentAddressedEvent(event: EvidenceEventV1): {
  readonly key: Hash;
  readonly bytes: Uint8Array;
  readonly contentSha256: Hash;
} {
  const bytes = encodeEvidenceEvent(event);
  const contentSha256 = sha256Hex(bytes);
  return Object.freeze({ key: event.eventId, bytes, contentSha256 });
}

export class ProductionEvidenceEmitterV1 {
  private readonly append: EvidenceAppendPortV1;
  private readonly emitterKind: "native" | "read-only-adapter";
  private readonly emitterCodeHash: Hash;
  private nextSequence = 0n;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: EvidenceEmitterOptionsV1) {
    this.append = options.append;
    this.emitterKind = options.emitterKind;
    this.emitterCodeHash = options.emitterCodeHash;
    if (options.initialSequence !== undefined) {
      const initial = BigInt(options.initialSequence);
      if (initial < 0n || initial.toString() !== options.initialSequence) {
        throw new TypeError("initial evidence sequence must be canonical decimal");
      }
      this.nextSequence = initial;
    }
  }

  /**
   * Serialize and append one already-sealed boundary.  A rejected append is a
   * hard error: no caller may turn it into a candidate failure and continue to
   * an external submission.
   */
  emit(value: EvidenceBoundaryObjectV1): Promise<EvidenceEmissionV1> {
    const requested = this.tail.then(async () => {
      const boundary = parseBoundary(value);
      const event = buildEvent(boundary, {
        append: this.append,
        emitterKind: this.emitterKind,
        emitterCodeHash: this.emitterCodeHash,
      });
      const content = encodeContentAddressedEvent(event);
      const sequence = this.nextSequence;
      const request: EvidenceAppendRequestV1 = Object.freeze({
        sequence: sequence.toString(),
        eventId: content.key,
        contentSha256: content.contentSha256,
        bytes: content.bytes,
      });
      let acknowledgement: unknown;
      try {
        acknowledgement = await this.append.appendFsyncMonotonic(request);
      } catch (error) {
        throw new EvidenceWriteFailedError("evidence append/fsync failed", { cause: error });
      }
      const receipt = assertAppendReceipt(acknowledgement, request, sequence);
      this.nextSequence = sequence + 1n;
      return Object.freeze({
        event,
        bytes: content.bytes,
        contentSha256: content.contentSha256,
        append: receipt,
      });
    });
    // Preserve the serial writer even after a failed request, while returning
    // the failure to the caller. The next append gets a fresh exact sequence.
    this.tail = requested.then(() => undefined, () => undefined);
    return requested;
  }

  get lastCommittedSequence(): string {
    return (this.nextSequence - 1n).toString();
  }
}

/** Narrow helper for tests and stores: verify content-addressed event bytes. */
export function decodeContentAddressedEvent(
  bytes: Uint8Array,
  expectedEventId: Hash,
  expectedContentSha256: Hash,
): EvidenceEventV1 {
  if (sha256Hex(bytes) !== expectedContentSha256) throw new TypeError("event content hash mismatch");
  const event = decodeEvidenceEvent(bytes);
  if (event.eventId !== expectedEventId) throw new TypeError("event id does not match content address");
  return event;
}

export type { ProcessAnchorV1, ReadOnlyArtifactRefV1 };
export {
  decodeProductionSixStepArtifactMaterialV1,
  readProductionSixStepArtifactMaterialV1,
  readProductionSixStepWitnessV1,
  productionSixStepBoundaryKeyV1,
  type ProductionSixStepArtifactCapabilityV1,
  type ProductionSixStepArtifactMaterialV1,
  type ProductionSixStepArtifactSealInputV1,
  type ProductionSixStepArtifactStoreV1,
  type ProductionSixStepEmissionCapabilityV1,
  type ProductionSixStepEmissionInputV1,
  type ProductionSixStepOwnerOptionsV1,
  type ProductionSixStepStableContextV1,
  type ProductionSixStepStoredArtifactV1,
  type ProductionSixStepWitnessCapabilityV1,
} from "./internal/six-step-production-owner.ts";
