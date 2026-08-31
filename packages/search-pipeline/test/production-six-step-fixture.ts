import {
  encodeCanonicalBytes,
  decodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type { PersistedGraphEdgeV1 } from "../../graph/src/index.ts";
import {
  createReadOnlyArtifactRef,
  type ProcessAnchorV1,
  type ReadOnlyArtifactLocatorV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  hashOrderedInstanceBindingsRoot,
  SIX_STEP_SCHEMA_MANIFESTS,
  type SixStepStageFactsV1,
} from "../../../specs/evidence/src/six-step.ts";
import {
  readProductionSixStepArtifactMaterialV1,
  readProductionSixStepWitnessV1,
  type EvidenceAppendRequestV1,
  type ProductionSixStepArtifactCapabilityV1,
  type ProductionSixStepArtifactMaterialV1,
  type ProductionSixStepArtifactSealInputV1,
  type ProductionSixStepEmissionCapabilityV1,
  type ProductionSixStepStableContextV1,
  type ProductionSixStepStoredArtifactV1,
  type ProductionSixStepWitnessCapabilityV1,
} from "../../evidence-emitter/src/index.ts";
import {
  ProductionSixStepArtifactOwnerV1,
  issueProductionSixStepArtifactStoreV1,
} from "../../evidence-emitter/src/internal/six-step-production-owner.ts";
import {
  type ProductionSixStepTailEmissionPortV1,
  type ResolvedRoutePipelineInputV1,
  type RouteCapabilityV1,
  type SearchStageTimingFactV1,
} from "../src/index.ts";
import { issueProductionSixStepTailEmissionPortV1 } from "../src/internal/six-step-tail-port-owner.ts";
import type { ContentAddressedObserverSinkV1 } from "../../../acceptance/collectors/src/content-addressed-sink.ts";

const h = (value: string): Hash => hashDomain("test/production-six-step-fixture", value);
const storeIdentityHash = h("store");
export const PRODUCTION_SIX_STEP_FIXTURE_RESOLVER_POLICY = createResolverPolicy({
  schemaVersion: 1,
  kind: "aloha.artifact-resolver-policy",
  allowedLocatorKind: "content-object",
  digestAlgorithm: "sha256",
  maxByteLength: "500000",
  requireExactLengthMediaAndSchema: true,
  minimumRemainingStoreEpochs: "0",
  failureOutcome: "invalid",
});
const resolverPolicyHash = PRODUCTION_SIX_STEP_FIXTURE_RESOLVER_POLICY.policyHash;
const issuerQualificationId = h("issuer-qualification");
const qualificationRegistryRoot = h("qualification-registry");
const schema = Object.freeze({
  id: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.id,
  version: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.version,
  schemaHash: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.schemaHash,
});

const canonical = (value: unknown): CanonicalJsonObject => decodeCanonicalJson(encodeCanonicalBytes(value)) as CanonicalJsonObject;

class MemoryStore {
  readonly boundaries = new Map<Hash, ProductionSixStepArtifactMaterialV1>();
  readonly sink: ContentAddressedObserverSinkV1 | null;
  constructor(sink: ContentAddressedObserverSinkV1 | null = null) { this.sink = sink; }

  async seal(input: ProductionSixStepArtifactSealInputV1): Promise<ProductionSixStepStoredArtifactV1> {
    const bytes = Uint8Array.from(input.bytes);
    const contentSha256 = sha256Hex(bytes);
    if (this.sink !== null) {
      if (input.schema === null) throw new TypeError("production Six-Step fixture artifact schema is required");
      const mirrored = await this.sink.write({ bytes, mediaType: input.mediaType, schema: input.schema });
      const ref = createReadOnlyArtifactRef({
        locator: input.locator,
        immutableMirrorLocator: mirrored.ref.immutableMirrorLocator,
        contentSha256,
        byteLength: String(bytes.byteLength),
        mediaType: input.mediaType,
        schema: input.schema,
        resolverPolicyHash: mirrored.ref.resolverPolicyHash,
        retentionLeaseReceiptId: mirrored.lease.receiptId,
      });
      const claim = createArtifactResolutionClaim({
        artifactRefId: ref.artifactRefId,
        resolverPolicyHash: mirrored.claim.resolverPolicyHash,
        observedMirror: mirrored.claim.observedMirror,
        outcome: "content-observed",
      });
      return Object.freeze({ bytes, ref, claim, lease: mirrored.lease });
    }
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash,
      objectKey: contentSha256,
      contentSha256,
      validFromStoreEpoch: "1",
      validThroughStoreEpoch: "1",
      issuerId: "aloha.test.production-six-step",
      issuerQualificationId,
      qualificationRegistryRoot,
    });
    const immutableMirrorLocator = Object.freeze({ kind: "content-object" as const, storeIdentityHash, objectKey: contentSha256 });
    const ref = createReadOnlyArtifactRef({
      locator: input.locator,
      immutableMirrorLocator,
      contentSha256,
      byteLength: String(bytes.byteLength),
      mediaType: input.mediaType,
      schema: input.schema,
      resolverPolicyHash,
      retentionLeaseReceiptId: lease.receiptId,
    });
    const observedMirror = createObservedImmutableMirror({
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: encodeArtifactBytes(bytes),
      mediaType: input.mediaType,
      schema: input.schema,
    });
    const claim = createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash,
      observedMirror,
      outcome: "content-observed",
    });
    return Object.freeze({ bytes, ref, claim, lease });
  }

  async loadBoundary(key: Hash) { return this.boundaries.get(key) ?? null; }
  async persistBoundary(key: Hash, material: ProductionSixStepArtifactMaterialV1) { this.boundaries.set(key, material); }
}

const processAnchor: ProcessAnchorV1 = Object.freeze({
  systemId: "aloha-test-searcher",
  commitSha: "a".repeat(40),
  executableHash: h("executable"),
  deploymentManifestHash: h("manifest"),
  serviceIdentityHash: h("service"),
  pid: "42",
  processStartTicks: "100",
  bootIdHash: h("boot"),
});

function contentLocator(key: string): ReadOnlyArtifactLocatorV1 {
  return Object.freeze({ kind: "content-object", storeIdentityHash, objectKey: h(key) });
}

function logLocator(stage: number, byteLength: number): ReadOnlyArtifactLocatorV1 {
  const start = BigInt(stage * 1000);
  return Object.freeze({
    kind: "file-range",
    systemId: processAnchor.systemId,
    bootIdHash: processAnchor.bootIdHash,
    device: "1",
    inode: "2",
    startInclusive: start.toString(),
    endExclusive: (start + BigInt(byteLength)).toString(),
  });
}

export function createProductionSixStepTailFixture(
  events: string[],
  options: Readonly<{
    readonly sink?: ContentAddressedObserverSinkV1;
    readonly process?: ProcessAnchorV1;
    readonly fileRangeStride?: number;
    readonly rawBoundaryPayloadTransform?: (
      stageId: SixStepStageFactsV1["stageId"],
      payload: CanonicalJsonObject,
    ) => CanonicalJsonObject;
    readonly stage12?: Readonly<{
      readonly binding: Readonly<{
        readonly readyRecordHash: Hash;
        readonly generationId: string;
        readonly cutoff: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
        readonly definitionCatalogRoot: Hash;
        readonly sourceCoverageRoot: Hash;
        readonly candidatePartitionRoot: Hash;
        readonly exactOutcomePartitionRoot: Hash;
        readonly verifiedMemoSetRoot: Hash;
        readonly instanceCatalogRoot: Hash;
        readonly graphRoot: Hash;
        readonly releaseProvenanceHash: Hash;
        readonly promotionRevision: string;
      }>;
      readonly selectedGraphLegs: readonly Readonly<{
        readonly edgeId: Hash;
        readonly owningFamilyId: string;
        readonly owningFamilyDefinitionHash: Hash;
        readonly owningInstanceKey: string;
        readonly instancePublicationHash: Hash;
        readonly staticProjectionHash: Hash;
        readonly projectionHash: Hash;
      }>[];
      readonly readyEdges?: readonly PersistedGraphEdgeV1[];
    }>;
  }> = {},
): ProductionSixStepTailEmissionPortV1 {
  const memory = new MemoryStore(options.sink ?? null);
  const fixtureProcess = options.process ?? processAnchor;
  const fixtureStoreIdentityHash = options.sink?.storeIdentityHash ?? storeIdentityHash;
  let appendOffset = 0n;
  const owner = new ProductionSixStepArtifactOwnerV1({
    process: fixtureProcess,
    emitterCodeHash: h("emitter"),
    evidenceLog: { device: "1", inode: "2" },
    store: issueProductionSixStepArtifactStoreV1(memory),
    append: {
      async appendFsyncMonotonic(request: EvidenceAppendRequestV1) {
        const start = appendOffset;
        appendOffset += BigInt(request.bytes.byteLength);
        return Object.freeze({
          sequence: request.sequence,
          eventId: request.eventId,
          contentSha256: request.contentSha256,
          byteLength: String(request.bytes.byteLength),
          offsetStart: start.toString(),
          offsetEnd: appendOffset.toString(),
          fsynced: true as const,
        });
      },
    },
  });

  const fixtureContentLocator = (key: string): ReadOnlyArtifactLocatorV1 => Object.freeze({ kind: "content-object", storeIdentityHash: fixtureStoreIdentityHash, objectKey: h(key) });
  const fixtureLogLocator = (stage: number, byteLength: number): ReadOnlyArtifactLocatorV1 => {
    const start = BigInt(stage * (options.fileRangeStride ?? 1000));
    return Object.freeze({ kind: "file-range", systemId: fixtureProcess.systemId, bootIdHash: fixtureProcess.bootIdHash, device: "1", inode: "2", startInclusive: start.toString(), endExclusive: (start + BigInt(byteLength)).toString() });
  };
  const artifact = async (key: string, payload: CanonicalJsonObject, stage: number): Promise<ProductionSixStepArtifactCapabilityV1> => {
    const ordinal = Number(/^s([1-6])/.exec(key)?.[1]);
    const stageId = (["", "universe_instance", "edge_ready_generation", "planner_consumption", "current_source_exact", "execution_program", "final_simulation"] as const)[ordinal]! as SixStepStageFactsV1["stageId"];
    const storedPayload = stage === 0 && options.rawBoundaryPayloadTransform !== undefined
      ? canonical(options.rawBoundaryPayloadTransform(stageId, payload))
      : payload;
    const bytes = encodeCanonicalBytes({ schemaVersion: 1, kind: "aloha.six-step-native-boundary-record", stageId, role: stage === 0 ? "raw-boundary" : "native-log", payload: storedPayload });
    return owner.sealArtifact({ artifactKey: h(key), bytes, locator: stage === 0 ? fixtureContentLocator(key) : fixtureLogLocator(stage, bytes.byteLength), mediaType: "application/json", schema });
  };
  const witness = (stageId: SixStepStageFactsV1["stageId"], role: string, payload: CanonicalJsonObject): Promise<ProductionSixStepWitnessCapabilityV1> => owner.sealWitness({ artifactKey: h(`${stageId}:${role}:${JSON.stringify(payload)}`), stageId, role, payload, locator: fixtureContentLocator(`${stageId}:${role}:${JSON.stringify(payload)}`) });
  const stage12 = new Map<string, Promise<ProductionSixStepEmissionCapabilityV1>>();
  const stage1ByStage2 = new WeakMap<object, ProductionSixStepEmissionCapabilityV1>();
  const stage12ByStage3 = new WeakMap<object, Readonly<{
    readonly stage1: readonly ProductionSixStepEmissionCapabilityV1[];
    readonly stage2: readonly ProductionSixStepEmissionCapabilityV1[];
  }>>();

  const parentFor = (pipeline: ResolvedRoutePipelineInputV1, route: RouteCapabilityV1, index: number) => {
    const selectedLeg = options.stage12?.selectedGraphLegs.find(leg => leg.edgeId === route.legs[index]!.edgeId);
    const instanceKey = selectedLeg?.owningInstanceKey ?? route.legs[index]!.ownerRef;
    const stage12Key = `${route.legs[index]!.edgeId}:${instanceKey}`;
    let pending = stage12.get(stage12Key);
    if (pending !== undefined) return pending;
    pending = (async () => {
      const base = { instanceKey, routeHash: route.routeHash } as const;
      const readyEdge = options.stage12?.readyEdges?.find(edge => edge.edgeId === route.legs[index]!.edgeId);
      const ready = selectedLeg === undefined ? undefined : options.stage12?.binding;
      const publicationPayload = canonical(selectedLeg === undefined
        ? { ...base, role: "instance-publication" }
        : {
            instanceKey: selectedLeg.owningInstanceKey,
            instancePublicationHash: selectedLeg.instancePublicationHash,
            familyDefinitionHash: selectedLeg.owningFamilyDefinitionHash,
          });
      const edgePayload = canonical(selectedLeg === undefined
        ? { ...base, edgeId: route.legs[index]!.edgeId }
        : readyEdge ?? { ...selectedLeg });
      const s1Witnesses = await Promise.all([
        witness("universe_instance", "candidate-partition", ready === undefined
          ? { ...base, role: "candidate-partition" }
          : { runId: ready.readyRecordHash, candidatePartitionRoot: ready.candidatePartitionRoot }),
        witness("universe_instance", "instance-publication", publicationPayload),
        witness("universe_instance", "identity-proof", { ...base, role: "identity-proof" }),
        witness("universe_instance", "source-coverage", { ...base, role: "source-coverage" }),
      ]);
      const context1: ProductionSixStepStableContextV1 = Object.freeze({
        scope: { kind: "builder-run" as const, builderRunId: pipeline.lease.binding.readyRecordHash, producerSessionId: null, generationId: null, generationRefreshPolicyHash: pipeline.lease.binding.generationRefreshPolicyHash },
        correlationId: pipeline.correlationId,
        runSequence: String(index), cutoff: { number: pipeline.lease.binding.cutoff.number, hash: pipeline.lease.binding.cutoff.hash, stateRoot: pipeline.lease.binding.cutoff.stateRoot },
        definitionCatalogRoot: pipeline.lease.binding.definitionCatalogRoot, strategyCatalogRoot: null,
        instanceCatalogRoot: null, graphRoot: null, familyId: selectedLeg?.owningFamilyId ?? `fixture-family-${index}`,
        candidateKey: instanceKey, familyDefinitionHash: selectedLeg?.owningFamilyDefinitionHash ?? h(`family-${index}`), capabilities: [], instanceKey,
        sourceAnchorHash: h(`source-${index}`), semanticConfigDigest: h("config"), resourceMetricsHash: h("metrics"),
      });
      const s1Raw = await artifact(`s1-raw-${instanceKey}`, ready === undefined
        ? { ...base, boundary: "outcome" }
        : {
            runId: ready.readyRecordHash,
            candidate: {
              familyId: selectedLeg!.owningFamilyId,
              familyDefinitionHash: selectedLeg!.owningFamilyDefinitionHash,
              familyCandidateKey: selectedLeg!.owningInstanceKey,
            },
            outcome: {
              instanceKey: selectedLeg!.owningInstanceKey,
              publication: publicationPayload,
            },
          }, 0);
      const s1Log = await artifact(`s1-log-${instanceKey}`, { ...base, boundary: "outcome-log" }, 1);
      const s1Facts: SixStepStageFactsV1 = { schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "universe_instance", candidatePartition: readProductionSixStepWitnessV1(s1Witnesses[0]!), instancePublication: readProductionSixStepWitnessV1(s1Witnesses[1]!), identityProof: readProductionSixStepWitnessV1(s1Witnesses[2]!), sourceCoverage: readProductionSixStepWitnessV1(s1Witnesses[3]!) };
      const s1 = await owner.emitStage({ context: context1, stage: { ordinal: 1, id: "universe_instance", version: 1 }, facts: s1Facts, outcome: "verified", reasonCode: null, startedMonotonicNs: "1000", finishedMonotonicNs: "2000", rawBoundary: s1Raw, logRange: s1Log, witnesses: s1Witnesses, parents: [] });
      const s2Witnesses = await Promise.all([
        Promise.resolve(s1Witnesses[1]!),
        witness("edge_ready_generation", "edge", edgePayload),
        witness("edge_ready_generation", "coverage", ready === undefined
          ? { ...base, role: "coverage" }
          : { sourceCoverageRoot: ready.sourceCoverageRoot }),
        witness("edge_ready_generation", "memo-reuse-proof", { ...base, mode: "fresh" }),
      ]);
      const context2: ProductionSixStepStableContextV1 = Object.freeze({ ...context1, scope: { kind: "ready-generation" as const, builderRunId: pipeline.lease.binding.readyRecordHash, producerSessionId: null, generationId: pipeline.lease.binding.generationId, generationRefreshPolicyHash: pipeline.lease.binding.generationRefreshPolicyHash }, runSequence: (BigInt(context1.runSequence) + 1n).toString(), instanceCatalogRoot: pipeline.lease.binding.instanceCatalogRoot, graphRoot: pipeline.lease.binding.graphRoot });
      const s2Raw = await artifact(`s2-raw-${instanceKey}`, ready === undefined
        ? { ...base, boundary: "ready" }
        : { ready, publication: publicationPayload, edge: edgePayload }, 0);
      const s2Log = await artifact(`s2-log-${instanceKey}`, { ...base, boundary: "ready-log" }, 2);
      const s2Facts: SixStepStageFactsV1 = { schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "edge_ready_generation", instancePublication: readProductionSixStepWitnessV1(s2Witnesses[0]!), edge: readProductionSixStepWitnessV1(s2Witnesses[1]!), coverage: readProductionSixStepWitnessV1(s2Witnesses[2]!), promotionRevision: ready?.promotionRevision ?? pipeline.lease.binding.generationId, generationId: pipeline.lease.binding.generationId, attestationMode: "fresh", memoReuseProof: readProductionSixStepWitnessV1(s2Witnesses[3]!) };
      const s2 = await owner.emitStage({ context: context2, stage: { ordinal: 2, id: "edge_ready_generation", version: 1 }, facts: s2Facts, outcome: "success", reasonCode: null, startedMonotonicNs: "2000", finishedMonotonicNs: "3000", rawBoundary: s2Raw, logRange: s2Log, witnesses: s2Witnesses, parents: [s1] });
      stage1ByStage2.set(s2, s1);
      return s2;
    })();
    stage12.set(stage12Key, pending);
    return pending;
  };

  const emit = async (stage: 3 | 4 | 5 | 6, pipeline: ResolvedRoutePipelineInputV1, route: RouteCapabilityV1, payload: CanonicalJsonObject, timing: SearchStageTimingFactV1, parents: readonly ProductionSixStepEmissionCapabilityV1[]) => {
    const roles = stage === 3 ? ["route-set", "coarse-projection", "admission-receipt"] : stage === 4 ? ["exact-output"] : stage === 5 ? ["program", "pre-calls", "observation-pairs", "action-owner"] : ["final-simulation-receipt", "economic-receipt", "safety-receipt"];
    const stageId = (["", "", "", "planner_consumption", "current_source_exact", "execution_program", "final_simulation"] as const)[stage]!;
    const rolePayloads = (payload.rolePayloads as unknown as readonly CanonicalJsonObject[] | undefined)
      ?? roles.map((role) => ({ role, payload }));
    if (rolePayloads.length !== roles.length) {
      throw new TypeError(`production Six-Step fixture Stage ${stage} witness payload denominator mismatch`);
    }
    const witnesses = await Promise.all(roles.map((role, index) => witness(stageId, role, rolePayloads[index]!)));
    const w = witnesses.map(readProductionSixStepWitnessV1);
    let facts: SixStepStageFactsV1;
    if (stage === 3) {
      const materials = parents.map(readProductionSixStepArtifactMaterialV1);
      const bindings = materials.map((material, index) => {
        const parentFacts = material.event.facts as { readonly instancePublication: { readonly contentRoot: Hash } };
        return { edgeId: route.legs[index]!.edgeId, instanceKey: material.event.instanceKey!, stage1EventId: material.event.parentEventIds[0]!, stage2EventId: material.event.eventId, instancePublicationRoot: parentFacts.instancePublication.contentRoot };
      });
      facts = { schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "planner_consumption", orderedInstanceBindings: bindings, orderedInstanceBindingsRoot: hashOrderedInstanceBindingsRoot(bindings), routeSet: w[0]!, coarseProjection: w[1]!, admissionReceipt: w[2]!, admissionClass: payload.admissionClass === "ranked" ? "ranked" : "bounded-unranked" };
    } else if (stage === 4) facts = { schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "current_source_exact", currentSource: { ...pipeline.currentSource.source, hash: pipeline.currentSource.source.hash as Hash, stateRoot: pipeline.currentSource.source.stateRoot as Hash }, exactOutput: w[0]!, fallback: false };
    else if (stage === 5) facts = { schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "execution_program", program: w[0]!, callerMode: String(payload.callerMode), preCalls: w[1]!, observationPairs: w[2]!, actionOwner: w[3]!, fallback: false };
    else facts = { schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "final_simulation", finalSimulationReceipt: w[0]!, simulationSourceAnchor: { ...pipeline.currentSource.source, hash: pipeline.currentSource.source.hash as Hash, stateRoot: pipeline.currentSource.source.stateRoot as Hash }, economicReceipt: w[1]!, safetyReceipt: w[2]!, dryRun: true };
    const raw = await artifact(`s${stage}-raw-${pipeline.correlationId}`, payload, 0);
    const log = await artifact(`s${stage}-log-${pipeline.correlationId}`, { stage: String(stage), payloadRoot: hashDomain("aloha/test-six-step-payload/v1", payload) }, stage);
    const context: ProductionSixStepStableContextV1 = Object.freeze({ scope: { kind: "producer-session" as const, builderRunId: pipeline.lease.binding.readyRecordHash, producerSessionId: pipeline.currentSource.sessionId, generationId: pipeline.lease.binding.generationId, generationRefreshPolicyHash: pipeline.lease.binding.generationRefreshPolicyHash }, correlationId: pipeline.correlationId, runSequence: String(stage), cutoff: { number: pipeline.lease.binding.cutoff.number, hash: pipeline.lease.binding.cutoff.hash, stateRoot: pipeline.lease.binding.cutoff.stateRoot }, definitionCatalogRoot: pipeline.lease.binding.definitionCatalogRoot, strategyCatalogRoot: h("strategy-catalog"), instanceCatalogRoot: pipeline.lease.binding.instanceCatalogRoot, graphRoot: pipeline.lease.binding.graphRoot, familyId: "fixture-route", candidateKey: pipeline.routeCandidateId, familyDefinitionHash: h("route-family"), capabilities: [], instanceKey: options.stage12?.selectedGraphLegs[0]?.owningInstanceKey ?? route.legs[0]!.ownerRef, sourceAnchorHash: h(`source-${pipeline.currentSource.source.hash}`), semanticConfigDigest: h("config"), resourceMetricsHash: h("metrics") });
    const result = await owner.emitStage({ context, stage: { ordinal: stage, id: stageId, version: 1 }, facts, outcome: "success", reasonCode: null, startedMonotonicNs: timing.startedMonotonicNs, finishedMonotonicNs: timing.finishedMonotonicNs, rawBoundary: raw, logRange: log, witnesses, parents });
    events.push(`six-step-${stage}`);
    return result;
  };

  return issueProductionSixStepTailEmissionPortV1({
    emitPlanner: async ({ pipeline, route, coarse, planned, timing }) => {
      try {
        const stage2 = await Promise.all(route.legs.map((_, index) => parentFor(pipeline, route, index)));
        const stage1 = stage2.map(parent => {
          const capability = stage1ByStage2.get(parent);
          if (capability === undefined) throw new TypeError("fixture Stage 1 parent is unavailable");
          return capability;
        });
        const admissionClass = (coarse as Readonly<{ readonly kind?: string }>).kind === "rankable"
          ? "ranked"
          : "bounded-unranked";
        const stage3 = await emit(3, pipeline, route, canonical({
          routeCandidateId: pipeline.routeCandidateId,
          orderedEdgeIds: pipeline.orderedEdgeIds,
          routeHash: route.routeHash,
          routeBindingHash: route.routeBindingHash,
          coarse,
          planned,
          admissionClass,
          rolePayloads: [
            { routeCandidateId: pipeline.routeCandidateId, orderedEdgeIds: pipeline.orderedEdgeIds, routeHash: route.routeHash },
            { coarse },
            { planned, admissionClass },
          ],
        }), timing, stage2);
        stage12ByStage3.set(stage3, Object.freeze({ stage1: Object.freeze(stage1), stage2: Object.freeze(stage2) }));
        return stage3;
      } catch (error) {
        events.push(`six-step-error:${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    emitExact: async ({ parent, pipeline, route, exact, timing }) => emit(4, pipeline, route, canonical({
      exact,
      rolePayloads: [{ exact }],
    }), timing, [parent]),
    emitExecutionProgram: async ({ parent, pipeline, route, program, ownerEvidence, timing }) => {
      const facts = canonical(ownerEvidence.facts) as CanonicalJsonObject;
      return emit(5, pipeline, route, canonical({
        program,
        ownerEvidence,
        callerMode: facts.callerMode,
        rolePayloads: [
          { program },
          { preCalls: facts.preCalls },
          { observationPairs: facts.observationPairs },
          { actionOwners: facts.actionOwners },
        ],
      }), timing, [parent]);
    },
    emitFinalSimulation: async ({ parent, pipeline, route, program, simulation, ownerEvidence, economicSafety, timing }) => emit(6, pipeline, route, canonical({
      program,
      simulation,
      ownerEvidence,
      economicSafety,
      rolePayloads: [
        { simulation, ownerEvidence },
        { economic: economicSafety.economic },
        { safety: economicSafety.safety },
      ],
    }), timing, [parent]),
    readStage12Parents(stage3) {
      const parents = stage12ByStage3.get(stage3);
      if (parents === undefined) throw new TypeError("fixture Stage 3 capability was not issued");
      return parents;
    },
  });
}
