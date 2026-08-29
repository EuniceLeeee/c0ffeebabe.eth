import {
  assertDecimalString,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  createProductionReceipt,
  createSemanticArtifact,
  decodeProductionReceipt,
  decodeReadOnlyArtifactRef,
  decodeSemanticArtifact,
  encodeProductionReceipt,
  encodeSemanticArtifact,
  CORE_SCHEMA_MANIFESTS,
  type ProcessAnchorV1,
  type ReadOnlyArtifactLocatorV1,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
  type StableReasonCode,
} from "../../../../specs/core-envelope/src/index.ts";
import {
  decodeArtifactBytes,
  decodeArtifactResolutionClaim,
  decodeRetentionLeaseReceipt,
  type ArtifactResolutionClaimV1,
  type RetentionLeaseReceiptV1,
} from "../../../../specs/artifact-resolution/src/index.ts";
import {
  decodeEvidenceEvent,
  EVIDENCE_SCHEMA_MANIFESTS,
  type CapabilityRefV1,
  type EvidenceOutcome,
  type EvidenceScopeV1,
  type EvidenceStageV1,
} from "../../../../specs/evidence/src/index.ts";
import {
  decodeSixStepEventFact,
  decodeSixStepNativeBoundaryRecord,
  decodeSixStepStageFacts,
  decodeSixStepWitnessContent,
  encodeSixStepWitnessContent,
  hashSixStepWitnessContentRoot,
  stageFactsSchemaRef,
  stageInputSchemaRef,
  SIX_STEP_SCHEMA_MANIFESTS,
  type SixStepEventFactV1,
  type SixStepEvidenceWitnessV1,
  type SixStepStageFactsV1,
  type SixStepStageId,
  type SixStepWitnessContentV1,
} from "../../../../specs/evidence/src/six-step.ts";
import {
  decodeContentAddressedEvent,
  ProductionEvidenceEmitterV1,
  type EvidenceAppendPortV1,
  type EvidenceAppendReceiptV1,
  type EvidenceEmissionV1,
} from "../index.ts";

export interface ProductionSixStepStoredArtifactV1 {
  readonly bytes: Uint8Array;
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claim: ArtifactResolutionClaimV1;
  readonly lease: RetentionLeaseReceiptV1;
}

export interface ProductionSixStepArtifactSealInputV1 {
  readonly artifactKey: Hash;
  readonly bytes: Uint8Array;
  readonly locator: ReadOnlyArtifactLocatorV1;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
}

export interface ProductionSixStepArtifactStoreV1 {
  readonly seal: (input: ProductionSixStepArtifactSealInputV1) => Promise<ProductionSixStepStoredArtifactV1>;
  readonly loadBoundary: (boundaryKey: Hash) => Promise<ProductionSixStepArtifactMaterialV1 | null>;
  readonly persistBoundary: (boundaryKey: Hash, material: ProductionSixStepArtifactMaterialV1) => Promise<void>;
}

const issuedStores = new WeakSet<object>();

/** Internal composition edge. Production bootstrap supplies the fixed store
 * implementation; ordinary stage callers never receive this issuer. */
export function issueProductionSixStepArtifactStoreV1(
  store: ProductionSixStepArtifactStoreV1,
): ProductionSixStepArtifactStoreV1 {
  if (store === null || typeof store !== "object"
    || typeof store.seal !== "function"
    || typeof store.loadBoundary !== "function"
    || typeof store.persistBoundary !== "function") {
    throw new TypeError("production Six-Step artifact store is incomplete");
  }
  issuedStores.add(store);
  return store;
}

function assertIssuedStore(value: unknown): asserts value is ProductionSixStepArtifactStoreV1 {
  if (value === null || typeof value !== "object" || !issuedStores.has(value)) {
    throw new TypeError("production Six-Step artifact store is not owner-issued");
  }
}

export type ProductionSixStepArtifactCapabilityV1 = object;
export type ProductionSixStepWitnessCapabilityV1 = object;
export type ProductionSixStepEmissionCapabilityV1 = object;

interface ArtifactCapabilityStateV1 {
  readonly artifact: ProductionSixStepStoredArtifactV1;
}

interface WitnessCapabilityStateV1 extends ArtifactCapabilityStateV1 {
  readonly content: SixStepWitnessContentV1;
  readonly witness: SixStepEvidenceWitnessV1;
}

export interface ProductionSixStepArtifactMaterialV1 {
  readonly boundaryKey: Hash;
  readonly boundaryFingerprint: Hash;
  readonly event: EvidenceEmissionV1["event"];
  readonly eventArtifact: ProductionSixStepStoredArtifactV1;
  readonly semanticArtifact: ReturnType<typeof createSemanticArtifact>;
  readonly semanticArtifactRef: ProductionSixStepStoredArtifactV1;
  readonly productionReceipt: ReturnType<typeof createProductionReceipt>;
  readonly productionReceiptRef: ProductionSixStepStoredArtifactV1;
  readonly inputArtifacts: readonly ProductionSixStepStoredArtifactV1[];
  readonly witnessArtifacts: readonly ProductionSixStepStoredArtifactV1[];
  readonly append: EvidenceAppendReceiptV1;
  readonly eventFact: SixStepEventFactV1;
  readonly artifactSetRoot: Hash;
}

const artifactCapabilities = new WeakMap<object, ArtifactCapabilityStateV1>();
const witnessCapabilities = new WeakMap<object, WitnessCapabilityStateV1>();
const emissionCapabilities = new WeakMap<object, ProductionSixStepArtifactMaterialV1>();

function artifactState(capability: ProductionSixStepArtifactCapabilityV1): ArtifactCapabilityStateV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("production Six-Step artifact capability is invalid");
  }
  const state = artifactCapabilities.get(capability);
  if (state === undefined) throw new TypeError("production Six-Step artifact capability was not issued");
  return state;
}

function witnessState(capability: ProductionSixStepWitnessCapabilityV1): WitnessCapabilityStateV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("production Six-Step witness capability is invalid");
  }
  const state = witnessCapabilities.get(capability);
  if (state === undefined) throw new TypeError("production Six-Step witness capability was not issued");
  return state;
}

export interface ProductionSixStepStableContextV1 {
  readonly scope: EvidenceScopeV1;
  readonly correlationId: string;
  readonly runSequence: string;
  readonly cutoff: Readonly<{ readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash | null;
  readonly instanceCatalogRoot: Hash | null;
  readonly graphRoot: Hash | null;
  readonly familyId: string;
  readonly candidateKey: string;
  readonly familyDefinitionHash: Hash;
  readonly capabilities: readonly CapabilityRefV1[];
  readonly instanceKey: string | null;
  readonly sourceAnchorHash: Hash;
  readonly semanticConfigDigest: Hash;
  readonly resourceMetricsHash: Hash;
}

export interface ProductionSixStepEmissionInputV1 {
  readonly context: ProductionSixStepStableContextV1;
  readonly stage: EvidenceStageV1;
  readonly facts: SixStepStageFactsV1;
  readonly outcome: EvidenceOutcome;
  readonly reasonCode: StableReasonCode | null;
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly rawBoundary: ProductionSixStepArtifactCapabilityV1;
  readonly logRange: ProductionSixStepArtifactCapabilityV1;
  readonly witnesses: readonly ProductionSixStepWitnessCapabilityV1[];
  readonly parents: readonly ProductionSixStepEmissionCapabilityV1[];
}

export interface ProductionSixStepOwnerOptionsV1 {
  readonly process: ProcessAnchorV1;
  readonly emitterCodeHash: Hash;
  readonly evidenceLog: Readonly<{
    readonly device: string;
    readonly inode: string;
  }>;
  readonly append: EvidenceAppendPortV1;
  readonly store: ProductionSixStepArtifactStoreV1;
  readonly initialAppendSequence?: string;
}

const stageIds = [
  "universe_instance",
  "edge_ready_generation",
  "planner_consumption",
  "current_source_exact",
  "execution_program",
  "final_simulation",
] as const;

function stageWitnesses(facts: SixStepStageFactsV1): readonly [string, SixStepEvidenceWitnessV1][] {
  switch (facts.stageId) {
    case "universe_instance": return [["candidate-partition", facts.candidatePartition], ["instance-publication", facts.instancePublication], ["identity-proof", facts.identityProof], ["source-coverage", facts.sourceCoverage]];
    case "edge_ready_generation": return [["instance-publication", facts.instancePublication], ["edge", facts.edge], ["coverage", facts.coverage], ["memo-reuse-proof", facts.memoReuseProof]];
    case "planner_consumption": return [["route-set", facts.routeSet], ["coarse-projection", facts.coarseProjection], ["admission-receipt", facts.admissionReceipt]];
    case "current_source_exact": return [["exact-output", facts.exactOutput]];
    case "execution_program": return [["program", facts.program], ["pre-calls", facts.preCalls], ["observation-pairs", facts.observationPairs], ["action-owner", facts.actionOwner]];
    case "final_simulation": return [["final-simulation-receipt", facts.finalSimulationReceipt], ["economic-receipt", facts.economicReceipt], ["safety-receipt", facts.safetyReceipt]];
  }
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function validateParentShape(stage: number, parents: readonly ProductionSixStepArtifactMaterialV1[], facts: SixStepStageFactsV1): void {
  if (stage === 1 && parents.length !== 0) throw new TypeError("Stage 1 cannot have a parent");
  if (stage === 2 && (parents.length !== 1 || parents[0]!.event.stage.ordinal !== 1)) {
    throw new TypeError("Stage 2 requires its exact Stage 1 parent");
  }
  if (stage === 3) {
    if (parents.length === 0 || parents.some(parent => parent.event.stage.ordinal !== 2)) {
      throw new TypeError("Stage 3 requires the exact ordered Stage 2 route parents");
    }
    if (facts.stageId !== "planner_consumption" || facts.orderedInstanceBindings.length !== parents.length) {
      throw new TypeError("Stage 3 ordered route denominator does not match its parents");
    }
    for (const [index, parent] of parents.entries()) {
      const binding = facts.orderedInstanceBindings[index]!;
      const parentFacts = decodeSixStepStageFacts(parent.event.facts);
      if (parentFacts.stageId !== "edge_ready_generation") throw new TypeError(`Stage 3 route parent ${index} facts are not Stage 2`);
      const edgeArtifact = parent.witnessArtifacts.find(artifact => decodeSixStepWitnessContent(artifact.bytes).role === "edge");
      const edgeContent = edgeArtifact === undefined ? null : decodeSixStepWitnessContent(edgeArtifact.bytes);
      if (binding.stage2EventId !== parent.event.eventId
        || binding.stage1EventId !== parent.event.parentEventIds[0]
        || binding.instanceKey !== parent.event.instanceKey
        || binding.instancePublicationRoot !== parentFacts.instancePublication.contentRoot
        || edgeContent === null
        || edgeContent.payload.edgeId !== binding.edgeId) {
        throw new TypeError(`Stage 3 route parent ${index} is not exact`);
      }
    }
  }
  if (stage >= 4 && (parents.length !== 1 || parents[0]!.event.stage.ordinal !== stage - 1)) {
    throw new TypeError(`Stage ${stage} requires its exact prior tail event`);
  }
}

function validateTailContext(
  stage: number,
  parents: readonly ProductionSixStepArtifactMaterialV1[],
  context: ProductionSixStepStableContextV1,
  process: ProcessAnchorV1,
): void {
  if (stage < 3) return;
  if (stage === 3) {
    if (context.scope.kind !== "producer-session") {
      throw new TypeError("Stage 3 requires a producer-session context");
    }
    for (const [index, parent] of parents.entries()) {
      const event = parent.event;
      const facts = decodeSixStepStageFacts(event.facts);
      if (event.runtime.commitSha !== process.commitSha
        || event.runtime.pid !== process.pid
        || event.runtime.processStartTicks !== process.processStartTicks
        || event.runtime.bootIdHash !== process.bootIdHash
        || event.scope.kind !== "ready-generation"
        || event.scope.builderRunId !== context.scope.builderRunId
        || event.scope.generationId !== context.scope.generationId
        || event.scope.generationRefreshPolicyHash !== context.scope.generationRefreshPolicyHash
        || facts.stageId !== "edge_ready_generation"
        || facts.generationId !== context.scope.generationId
        || event.definitionCatalogRoot !== context.definitionCatalogRoot
        || event.instanceCatalogRoot !== context.instanceCatalogRoot
        || event.graphRoot !== context.graphRoot
        || !same(event.capabilities, context.capabilities)
        || event.capabilitySetHash !== hashDomain("aloha/capability-set/v1", context.capabilities)
        || !same(event.cutoff, context.cutoff)) {
        throw new TypeError(`Stage 3 route parent ${index} crosses its Ready generation or producer process`);
      }
    }
    return;
  }
  const parent = parents[0];
  if (parent === undefined) return;
  const event = parent.event;
  if (event.runtime.commitSha !== process.commitSha
    || event.runtime.pid !== process.pid
    || event.runtime.processStartTicks !== process.processStartTicks
    || event.runtime.bootIdHash !== process.bootIdHash
    || !same(event.scope, context.scope)
    || event.correlationId !== context.correlationId
    || event.definitionCatalogRoot !== context.definitionCatalogRoot
    || event.strategyCatalogRoot !== context.strategyCatalogRoot
    || event.instanceCatalogRoot !== context.instanceCatalogRoot
    || event.graphRoot !== context.graphRoot
    || event.familyId !== context.familyId
    || event.candidateKey !== context.candidateKey
    || event.familyDefinitionHash !== context.familyDefinitionHash
    || !same(event.capabilities, context.capabilities)
    || event.capabilitySetHash !== hashDomain("aloha/capability-set/v1", context.capabilities)
    || event.instanceKey !== context.instanceKey
    || !same(event.cutoff, context.cutoff)) {
    throw new TypeError(`Stage ${stage} crosses its producer-session lineage`);
  }
}

function verifyStoredArtifact(value: ProductionSixStepStoredArtifactV1): ProductionSixStepStoredArtifactV1 {
  const bytes = Uint8Array.from(value.bytes);
  const ref = decodeReadOnlyArtifactRef(value.ref);
  const claim = decodeArtifactResolutionClaim(value.claim);
  const lease = decodeRetentionLeaseReceipt(value.lease);
  if (sha256Hex(bytes) !== ref.contentSha256
    || String(bytes.byteLength) !== ref.byteLength
    || ref.immutableMirrorLocator.kind !== "content-object"
    || ref.immutableMirrorLocator.objectKey !== ref.contentSha256
    || claim.artifactRefId !== ref.artifactRefId
    || claim.resolverPolicyHash !== ref.resolverPolicyHash
    || claim.outcome !== "content-observed"
    || claim.observedMirror === null
    || !sameBytes(decodeArtifactBytes(claim.observedMirror.bytes), bytes)
    || claim.observedMirror.contentSha256 !== ref.contentSha256
    || lease.receiptId !== ref.retentionLeaseReceiptId
    || lease.contentSha256 !== ref.contentSha256
    || lease.objectKey !== ref.immutableMirrorLocator.objectKey) {
    throw new TypeError("persisted production Six-Step artifact is not exact");
  }
  const declared = ref.schema;
  if (declared === null) throw new TypeError("production Six-Step artifacts require an exact schema manifest");
  const exactManifest = (manifest: Readonly<{ id: string; version: string; schemaHash: Hash }>) => same(declared, { id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash });
  if (exactManifest(CORE_SCHEMA_MANIFESTS.semanticArtifact)) decodeSemanticArtifact(bytes);
  else if (exactManifest(CORE_SCHEMA_MANIFESTS.productionReceipt)) decodeProductionReceipt(bytes);
  else if (exactManifest(EVIDENCE_SCHEMA_MANIFESTS.event)) decodeEvidenceEvent(bytes);
  else if (exactManifest(SIX_STEP_SCHEMA_MANIFESTS.witnessContent)) decodeSixStepWitnessContent(bytes);
  else if (exactManifest(SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord)) decodeSixStepNativeBoundaryRecord(bytes);
  else throw new TypeError("production Six-Step artifact schema manifest is not owned by the closure");
  return Object.freeze({ bytes, ref, claim, lease });
}

function artifactSetRootFor(input: Readonly<{
  eventFact: SixStepEventFactV1;
  eventArtifact: ProductionSixStepStoredArtifactV1;
  semanticArtifactRef: ProductionSixStepStoredArtifactV1;
  productionReceiptRef: ProductionSixStepStoredArtifactV1;
  inputArtifacts: readonly ProductionSixStepStoredArtifactV1[];
  witnessArtifacts: readonly ProductionSixStepStoredArtifactV1[];
}>): Hash {
  const all = [input.eventArtifact, input.semanticArtifactRef, input.productionReceiptRef, ...input.inputArtifacts];
  return hashDomain("aloha/production-six-step-artifact-set/v1", {
    eventFact: input.eventFact,
    inputArtifactRefIds: input.inputArtifacts.map(value => value.ref.artifactRefId),
    witnessArtifactRefIds: input.witnessArtifacts.map(value => value.ref.artifactRefId),
    resolutionClaimIds: all.map(value => value.claim.claimId),
    leaseReceiptIds: all.map(value => value.lease.receiptId),
  });
}

function boundaryFingerprintForMaterial(value: ProductionSixStepArtifactMaterialV1): Hash {
  const event = value.event;
  const receipt = value.productionReceipt;
  const rawBoundary = value.inputArtifacts[0];
  const logRange = value.inputArtifacts[1];
  if (rawBoundary === undefined || logRange === undefined) throw new TypeError("production Six-Step raw closure is incomplete");
  const context: ProductionSixStepStableContextV1 = {
    scope: event.scope,
    correlationId: event.correlationId,
    runSequence: event.runSequence,
    cutoff: event.cutoff,
    definitionCatalogRoot: event.definitionCatalogRoot,
    strategyCatalogRoot: event.strategyCatalogRoot,
    instanceCatalogRoot: event.instanceCatalogRoot,
    graphRoot: event.graphRoot,
    familyId: event.familyId,
    candidateKey: event.candidateKey,
    familyDefinitionHash: event.familyDefinitionHash,
    capabilities: event.capabilities,
    instanceKey: event.instanceKey,
    sourceAnchorHash: receipt.sourceAnchorHash,
    semanticConfigDigest: receipt.semanticConfigDigest,
    resourceMetricsHash: receipt.resourceMetricsHash,
  };
  const facts = decodeSixStepStageFacts(event.facts);
  const expectedBoundaryKey = productionSixStepBoundaryKeyV1({
    context,
    stage: event.stage,
    facts,
    parentEventIds: event.parentEventIds,
  });
  if (value.boundaryKey !== expectedBoundaryKey) {
    throw new TypeError("persisted production Six-Step boundary key mismatch");
  }
  return hashDomain("aloha/production-six-step-boundary/v1", {
    boundaryKey: expectedBoundaryKey,
    context,
    stage: event.stage,
    facts,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    startedMonotonicNs: event.latency.startedMonotonicNs,
    finishedMonotonicNs: event.latency.finishedMonotonicNs,
    rawBoundaryArtifactRefId: rawBoundary.ref.artifactRefId,
    logRangeArtifactRefId: logRange.ref.artifactRefId,
    witnessArtifactRefIds: value.witnessArtifacts.map(artifact => artifact.ref.artifactRefId),
    parentEventIds: event.parentEventIds,
  });
}

/** The semantic boundary identity is derived exclusively from producer-owned
 * stage facts and lineage. Durable material never gets to declare its own
 * lookup key. */
export function productionSixStepBoundaryKeyV1(input: Readonly<{
  readonly context: ProductionSixStepStableContextV1;
  readonly stage: EvidenceStageV1;
  readonly facts: SixStepStageFactsV1;
  readonly parentEventIds: readonly Hash[];
}>): Hash {
  return hashDomain("aloha/production-six-step-boundary-key/v1", {
    context: input.context,
    stage: input.stage,
    facts: decodeSixStepStageFacts(input.facts),
    parentEventIds: input.parentEventIds,
  });
}

function verifyPersistedMaterial(value: ProductionSixStepArtifactMaterialV1): ProductionSixStepArtifactMaterialV1 {
  const eventArtifact = verifyStoredArtifact(value.eventArtifact);
  const semanticArtifactRef = verifyStoredArtifact(value.semanticArtifactRef);
  const productionReceiptRef = verifyStoredArtifact(value.productionReceiptRef);
  const inputArtifacts = Object.freeze(value.inputArtifacts.map(verifyStoredArtifact));
  const witnessArtifacts = Object.freeze(value.witnessArtifacts.map(verifyStoredArtifact));
  const event = decodeContentAddressedEvent(eventArtifact.bytes, value.event.eventId, eventArtifact.ref.contentSha256);
  const semanticArtifact = decodeSemanticArtifact(semanticArtifactRef.bytes);
  const productionReceipt = decodeProductionReceipt(productionReceiptRef.bytes);
  const eventFact = decodeSixStepEventFact(value.eventFact);
  const facts = decodeSixStepStageFacts(event.facts);
  const expectedWitnesses = stageWitnesses(facts);
  const witnessExact = witnessArtifacts.length === expectedWitnesses.length
    && witnessArtifacts.every((artifact, index) => {
      const content = decodeSixStepWitnessContent(artifact.bytes);
      const [role, expected] = expectedWitnesses[index]!;
      const expectedStage = facts.stageId === "edge_ready_generation" && role === "instance-publication"
        ? "universe_instance"
        : facts.stageId;
      return content.stageId === expectedStage
        && content.role === role
        && expected.artifactRefId === artifact.ref.artifactRefId
        && expected.contentRoot === hashSixStepWitnessContentRoot(content)
        && inputArtifacts[index + 2]?.ref.artifactRefId === artifact.ref.artifactRefId;
    });
  if (!same(event, value.event)
    || !same(semanticArtifact, value.semanticArtifact)
    || !same(productionReceipt, value.productionReceipt)
    || productionReceipt.artifactId !== semanticArtifact.artifactId
    || event.artifactLineage.outputArtifactId !== semanticArtifact.artifactId
    || event.artifactLineage.productionReceiptId !== productionReceipt.receiptId
    || inputArtifacts.length < 2
    || !witnessExact
    || inputArtifacts[0]!.ref.artifactRefId === inputArtifacts[1]!.ref.artifactRefId
    || !same(semanticArtifact.inputArtifactIds, [inputArtifacts[0]!.ref.artifactRefId, ...witnessArtifacts.map(artifact => artifact.ref.artifactRefId)])
    || productionReceipt.rawBoundaryArtifactRef.artifactRefId !== inputArtifacts[0]!.ref.artifactRefId
    || productionReceipt.logRangeArtifactRef.artifactRefId !== inputArtifacts[1]!.ref.artifactRefId
    || eventFact.eventArtifactRefId !== eventArtifact.ref.artifactRefId
    || eventFact.semanticArtifactRefId !== semanticArtifactRef.ref.artifactRefId
    || eventFact.productionReceiptArtifactRefId !== productionReceiptRef.ref.artifactRefId
    || value.append.eventId !== event.eventId
    || value.append.contentSha256 !== eventArtifact.ref.contentSha256
    || value.append.byteLength !== String(eventArtifact.bytes.byteLength)
    || value.append.fsynced !== true
    || BigInt(value.append.offsetEnd) - BigInt(value.append.offsetStart) !== BigInt(value.append.byteLength)) {
    throw new TypeError("persisted production Six-Step material lineage is not exact");
  }
  const artifactSetRoot = artifactSetRootFor({ eventFact, eventArtifact, semanticArtifactRef, productionReceiptRef, inputArtifacts, witnessArtifacts });
  if (artifactSetRoot !== value.artifactSetRoot) throw new TypeError("persisted production Six-Step artifact root mismatch");
  const verified = Object.freeze({ ...value, event, eventArtifact, semanticArtifact, semanticArtifactRef, productionReceipt, productionReceiptRef, inputArtifacts, witnessArtifacts, eventFact, artifactSetRoot });
  if (boundaryFingerprintForMaterial(verified) !== value.boundaryFingerprint) throw new TypeError("persisted production Six-Step boundary fingerprint mismatch");
  return verified;
}

/** Restart observers may decode the root-owned physical boundary snapshot, but
 * they receive material only after the complete byte/ref/claim/lease closure
 * and all derived identities have been recomputed here. */
export function decodeProductionSixStepArtifactMaterialV1(
  value: unknown,
): ProductionSixStepArtifactMaterialV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("persisted production Six-Step material is invalid");
  }
  return verifyPersistedMaterial(value as ProductionSixStepArtifactMaterialV1);
}

export class ProductionSixStepArtifactOwnerV1 {
  readonly #process: ProcessAnchorV1;
  readonly #store: ProductionSixStepArtifactStoreV1;
  readonly #emitter: ProductionEvidenceEmitterV1;
  readonly #evidenceLog: ProductionSixStepOwnerOptionsV1["evidenceLog"];

  constructor(options: ProductionSixStepOwnerOptionsV1) {
    assertIssuedStore(options.store);
    assertDecimalString(options.evidenceLog.device, "sixStepOwner.evidenceLog.device");
    assertDecimalString(options.evidenceLog.inode, "sixStepOwner.evidenceLog.inode");
    this.#process = deepFreeze({ ...options.process });
    this.#store = options.store;
    this.#evidenceLog = deepFreeze({ ...options.evidenceLog });
    this.#emitter = new ProductionEvidenceEmitterV1({
      append: options.append,
      emitterKind: "native",
      emitterCodeHash: options.emitterCodeHash,
      ...(options.initialAppendSequence === undefined ? {} : { initialSequence: options.initialAppendSequence }),
    });
  }

  async sealArtifact(input: ProductionSixStepArtifactSealInputV1): Promise<ProductionSixStepArtifactCapabilityV1> {
    const artifact = verifyStoredArtifact(await this.#store.seal(input));
    if (!sameBytes(artifact.bytes, input.bytes)
      || artifact.ref.contentSha256 !== sha256Hex(input.bytes)
      || artifact.ref.byteLength !== input.bytes.byteLength.toString()
      || !same(artifact.ref.locator, input.locator)
      || artifact.ref.mediaType !== input.mediaType
      || !same(artifact.ref.schema, input.schema)
      || artifact.ref.immutableMirrorLocator.kind !== "content-object"
      || artifact.ref.immutableMirrorLocator.objectKey !== artifact.ref.contentSha256
      || artifact.claim.artifactRefId !== artifact.ref.artifactRefId
      || artifact.claim.outcome !== "content-observed"
      || artifact.lease.receiptId !== artifact.ref.retentionLeaseReceiptId
      || artifact.lease.contentSha256 !== artifact.ref.contentSha256) {
      throw new TypeError("production Six-Step artifact store returned a non-exact artifact");
    }
    const capability = Object.freeze(Object.create(null)) as ProductionSixStepArtifactCapabilityV1;
    artifactCapabilities.set(capability, Object.freeze({ artifact }));
    return capability;
  }

  /** Restart-only capability reopening. The durable store must return the
   * complete physically serialized closure; every byte/ref/claim/lease and
   * derived root is revalidated before a new process-local handle is issued. */
  async reopenBoundary(boundaryKey: Hash): Promise<ProductionSixStepEmissionCapabilityV1> {
    const material = await this.#store.loadBoundary(boundaryKey);
    if (material === null || material.boundaryKey !== boundaryKey) {
      throw new TypeError("production Six-Step boundary is not durable");
    }
    const verified = verifyPersistedMaterial(material);
    const capability = Object.freeze(Object.create(null)) as ProductionSixStepEmissionCapabilityV1;
    emissionCapabilities.set(capability, verified);
    return capability;
  }

  async sealWitness(input: Readonly<{
    readonly artifactKey: Hash;
    readonly stageId: SixStepStageId;
    readonly role: string;
    readonly payload: CanonicalJsonObject;
    readonly locator: ReadOnlyArtifactLocatorV1;
  }>): Promise<ProductionSixStepWitnessCapabilityV1> {
    const content: SixStepWitnessContentV1 = deepFreeze({
      schemaVersion: 1,
      kind: "aloha.six-step-evidence-witness",
      stageId: input.stageId,
      role: input.role,
      payload: input.payload,
    });
    const artifactCapability = await this.sealArtifact({
      artifactKey: input.artifactKey,
      bytes: encodeSixStepWitnessContent(content),
      locator: input.locator,
      mediaType: "application/json",
      schema: {
        id: SIX_STEP_SCHEMA_MANIFESTS.witnessContent.id,
        version: SIX_STEP_SCHEMA_MANIFESTS.witnessContent.version,
        schemaHash: SIX_STEP_SCHEMA_MANIFESTS.witnessContent.schemaHash,
      },
    });
    const state = artifactState(artifactCapability);
    const witness = deepFreeze({
      artifactRefId: state.artifact.ref.artifactRefId,
      contentRoot: hashSixStepWitnessContentRoot(content),
    });
    const capability = Object.freeze(Object.create(null)) as ProductionSixStepWitnessCapabilityV1;
    witnessCapabilities.set(capability, Object.freeze({ ...state, content, witness }));
    return capability;
  }

  async emitStage(input: ProductionSixStepEmissionInputV1): Promise<ProductionSixStepEmissionCapabilityV1> {
    const decodedFacts = decodeSixStepStageFacts(input.facts);
    const stage = input.stage.ordinal;
    if (stageIds[stage - 1] !== input.stage.id || decodedFacts.stageId !== input.stage.id) {
      throw new TypeError("production Six-Step stage identity mismatch");
    }
    const parents = input.parents.map(capability => readProductionSixStepArtifactMaterialV1(capability));
    validateParentShape(stage, parents, decodedFacts);
    validateTailContext(stage, parents, input.context, this.#process);
    const suppliedWitnesses = input.witnesses.map(witnessState);
    const expectedWitnesses = stageWitnesses(decodedFacts);
    if (suppliedWitnesses.length !== expectedWitnesses.length) {
      throw new TypeError("production Six-Step witness denominator is incomplete");
    }
    for (const [index, [role, witness]] of expectedWitnesses.entries()) {
      const supplied = suppliedWitnesses[index]!;
      const expectedStage = input.stage.id === "edge_ready_generation" && role === "instance-publication"
        ? "universe_instance"
        : input.stage.id;
      if (supplied.content.role !== role || supplied.content.stageId !== expectedStage || !same(supplied.witness, witness)) {
        throw new TypeError(`production Six-Step witness ${index} is not owner-issued for ${role}`);
      }
    }
    const rawBoundary = artifactState(input.rawBoundary).artifact;
    const logRange = artifactState(input.logRange).artifact;
    if (logRange.ref.locator.kind !== "file-range"
      || logRange.ref.locator.systemId !== this.#process.systemId
      || logRange.ref.locator.bootIdHash !== this.#process.bootIdHash) {
      throw new TypeError("production Six-Step log range does not bind the producer process");
    }
    const boundaryKey = productionSixStepBoundaryKeyV1({
      context: input.context,
      stage: input.stage,
      facts: decodedFacts,
      parentEventIds: parents.map(value => value.event.eventId),
    });
    const boundaryFingerprint = hashDomain("aloha/production-six-step-boundary/v1", {
      boundaryKey,
      context: input.context,
      stage: input.stage,
      facts: decodedFacts,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      startedMonotonicNs: input.startedMonotonicNs,
      finishedMonotonicNs: input.finishedMonotonicNs,
      rawBoundaryArtifactRefId: rawBoundary.ref.artifactRefId,
      logRangeArtifactRefId: logRange.ref.artifactRefId,
      witnessArtifactRefIds: suppliedWitnesses.map(value => value.artifact.ref.artifactRefId),
      parentEventIds: parents.map(value => value.event.eventId),
    });
    const existing = await this.#store.loadBoundary(boundaryKey);
    if (existing !== null) {
      if (existing.boundaryFingerprint !== boundaryFingerprint) {
        throw new TypeError("production Six-Step boundary key was reused with different facts");
      }
      const verified = verifyPersistedMaterial(existing);
      const capability = Object.freeze(Object.create(null)) as ProductionSixStepEmissionCapabilityV1;
      emissionCapabilities.set(capability, verified);
      return capability;
    }
    const stageInput = deepFreeze({
      schemaVersion: 1 as const,
      kind: "aloha.six-step-stage-input" as const,
      stageId: decodedFacts.stageId,
      rawBoundaryArtifactRefId: rawBoundary.ref.artifactRefId,
      orderedWitnessArtifactRefIds: suppliedWitnesses.map(value => value.artifact.ref.artifactRefId),
      parentEventIds: parents.map(value => value.event.eventId),
    });
    const outputHash = hashDomain("aloha/stage-output/v1", {
      stageId: decodedFacts.stageId,
      factSchema: stageFactsSchemaRef(),
      facts: decodedFacts,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
    });
    const semanticInputArtifacts = Object.freeze([rawBoundary, ...suppliedWitnesses.map(value => value.artifact)]);
    const semanticArtifact = createSemanticArtifact({
      schema: stageFactsSchemaRef(),
      inputArtifactIds: semanticInputArtifacts.map(value => value.ref.artifactRefId),
      dependencyClosureRoot: hashDomain("aloha/production-six-step-input-closure/v1", semanticInputArtifacts.map(value => value.ref.artifactRefId)),
      canonicalPayloadHash: outputHash,
    });
    const semanticBytes = encodeSemanticArtifact(semanticArtifact);
    const semanticArtifactRef = await this.#store.seal({
      artifactKey: semanticArtifact.artifactId,
      bytes: semanticBytes,
      locator: { kind: "content-object", storeIdentityHash: rawBoundary.ref.immutableMirrorLocator.storeIdentityHash, objectKey: sha256Hex(semanticBytes) },
      mediaType: "application/json",
      schema: {
        id: CORE_SCHEMA_MANIFESTS.semanticArtifact.id,
        version: CORE_SCHEMA_MANIFESTS.semanticArtifact.version,
        schemaHash: CORE_SCHEMA_MANIFESTS.semanticArtifact.schemaHash,
      },
    });
    const started = BigInt(assertDecimalString(input.startedMonotonicNs, "sixStep.startedMonotonicNs"));
    const finished = BigInt(assertDecimalString(input.finishedMonotonicNs, "sixStep.finishedMonotonicNs"));
    if (finished < started) throw new TypeError("production Six-Step monotonic time regressed");
    const productionReceipt = createProductionReceipt({
      artifactId: semanticArtifact.artifactId,
      producer: this.#process,
      logRangeArtifactRef: logRange.ref,
      sourceAnchorHash: input.context.sourceAnchorHash,
      startedMonotonicNs: started.toString(),
      finishedMonotonicNs: finished.toString(),
      durationUs: ((finished - started) / 1_000n).toString(),
      rawBoundaryArtifactRef: rawBoundary.ref,
      semanticConfigDigest: input.context.semanticConfigDigest,
      resourceMetricsHash: input.context.resourceMetricsHash,
    });
    const receiptBytes = encodeProductionReceipt(productionReceipt);
    const productionReceiptRef = await this.#store.seal({
      artifactKey: productionReceipt.receiptId,
      bytes: receiptBytes,
      locator: { kind: "content-object", storeIdentityHash: rawBoundary.ref.immutableMirrorLocator.storeIdentityHash, objectKey: sha256Hex(receiptBytes) },
      mediaType: "application/json",
      schema: {
        id: CORE_SCHEMA_MANIFESTS.productionReceipt.id,
        version: CORE_SCHEMA_MANIFESTS.productionReceipt.version,
        schemaHash: CORE_SCHEMA_MANIFESTS.productionReceipt.schemaHash,
      },
    });
    const emitted = await this.#emitter.emit({
      semanticArtifact,
      productionReceipt,
      scope: input.context.scope,
      correlationId: input.context.correlationId,
      runSequence: input.context.runSequence,
      cutoff: input.context.cutoff,
      definitionCatalogRoot: input.context.definitionCatalogRoot,
      strategyCatalogRoot: input.context.strategyCatalogRoot,
      instanceCatalogRoot: input.context.instanceCatalogRoot,
      graphRoot: input.context.graphRoot,
      familyId: input.context.familyId,
      candidateKey: input.context.candidateKey,
      familyDefinitionHash: input.context.familyDefinitionHash,
      capabilities: input.context.capabilities,
      instanceKey: input.context.instanceKey,
      stage: input.stage,
      inputSchema: stageInputSchemaRef(),
      inputs: stageInput,
      factSchema: stageFactsSchemaRef(),
      facts: decodedFacts as unknown as CanonicalJsonObject,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      parentEvents: parents.map(value => ({ event: value.event })),
      extensions: [],
    });
    const eventArtifact = await this.#store.seal({
      artifactKey: emitted.event.eventId,
      bytes: emitted.bytes,
      locator: {
        kind: "file-range",
        systemId: this.#process.systemId,
        bootIdHash: this.#process.bootIdHash,
        device: this.#evidenceLog.device,
        inode: this.#evidenceLog.inode,
        startInclusive: emitted.append.offsetStart,
        endExclusive: emitted.append.offsetEnd,
      },
      mediaType: "application/json",
      schema: {
        id: EVIDENCE_SCHEMA_MANIFESTS.event.id,
        version: EVIDENCE_SCHEMA_MANIFESTS.event.version,
        schemaHash: EVIDENCE_SCHEMA_MANIFESTS.event.schemaHash,
      },
    });
    const eventFact: SixStepEventFactV1 = deepFreeze({
      schemaVersion: 1,
      kind: "aloha.six-step-event-fact",
      eventArtifactRefId: eventArtifact.ref.artifactRefId,
      semanticArtifactRefId: semanticArtifactRef.ref.artifactRefId,
      productionReceiptArtifactRefId: productionReceiptRef.ref.artifactRefId,
    });
    const inputArtifacts = Object.freeze([rawBoundary, logRange, ...suppliedWitnesses.map(value => value.artifact)]);
    const witnessArtifacts = Object.freeze(suppliedWitnesses.map(value => value.artifact));
    const artifactSetRoot = artifactSetRootFor({ eventFact, eventArtifact, semanticArtifactRef, productionReceiptRef, inputArtifacts, witnessArtifacts });
    const material = Object.freeze({
      boundaryKey,
      boundaryFingerprint,
      event: emitted.event,
      eventArtifact,
      semanticArtifact,
      semanticArtifactRef,
      productionReceipt,
      productionReceiptRef,
      inputArtifacts,
      witnessArtifacts,
      append: emitted.append,
      eventFact,
      artifactSetRoot,
    });
    await this.#store.persistBoundary(boundaryKey, material);
    const capability = Object.freeze(Object.create(null)) as ProductionSixStepEmissionCapabilityV1;
    emissionCapabilities.set(capability, material);
    return capability;
  }
}

export function readProductionSixStepArtifactMaterialV1(
  capability: ProductionSixStepEmissionCapabilityV1,
): ProductionSixStepArtifactMaterialV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("production Six-Step emission capability is invalid");
  }
  const material = emissionCapabilities.get(capability);
  if (material === undefined) throw new TypeError("production Six-Step emission capability was not issued");
  return material;
}

/** Public witness identity only. The returned ref/root cannot be used to mint
 * an event; emitStage still requires the exact opaque witness capability. */
export function readProductionSixStepWitnessV1(
  capability: ProductionSixStepWitnessCapabilityV1,
): SixStepEvidenceWitnessV1 {
  return witnessState(capability).witness;
}
