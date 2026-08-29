import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createArtifactResolutionClaim,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  decodeArtifactBytes,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  createReadOnlyArtifactRef,
  createSemanticArtifact,
  createProductionReceipt,
  type ReadOnlyArtifactLocatorV1,
  encodeProductionReceipt,
  encodeSemanticArtifact,
  type ProcessAnchorV1,
  type ProductionReceiptV1,
  type ReadOnlyArtifactRefV1,
  type SemanticArtifactV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  decodeEvidenceEvent,
  encodeEvidenceEvent,
  type EvidenceEventV1,
} from "../../../specs/evidence/src/index.ts";
import {
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
import {
  ProductionEvidenceEmitterV1,
  readProductionSixStepArtifactMaterialV1,
  type EvidenceBoundaryObjectV1,
  type EvidenceAppendPortV1,
} from "../../../packages/evidence-emitter/src/index.ts";
import {
  createProductionSixStepTailFixture,
  PRODUCTION_SIX_STEP_FIXTURE_RESOLVER_POLICY,
} from "../../../packages/search-pipeline/test/production-six-step-fixture.ts";
import { sealEconomicSafetyEvidenceV1 } from "../../../packages/economics-safety/src/index.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  sealSafetyProfileV1,
} from "../../../specs/economic-safety-profile/src/index.ts";
import {
  decodeSixStepStageFacts,
  decodeSixStepWitnessContent,
  hashSixStepWitnessContentRoot,
  hashOrderedInstanceBindingsRoot,
  stageFactsSchemaRef,
  stageInputSchemaRef,
  type SixStepEvidenceWitnessV1,
  type SixStepEventFactV1,
  type SixStepStageId,
  type SixStepStageFactsV1,
  type SixStepWitnessContentV1,
} from "../src/schema.ts";
import {
  evaluateSixStepPredicate,
  type SixStepRuntimeFactsV1,
} from "../src/predicate.ts";
import {
  evaluateSixStepReferenceModel,
} from "../src/reference-model.ts";
import {
  qualifySixStepCorpus,
  executeSixStepQualificationCorpus,
  assertQualifiedSixStepCertificate,
  sealSixStepValuationOwnerQualificationCertificateV1,
  type SixStepQualificationFixtureV1,
  type SixStepMutationCaseV1,
} from "../src/qualification.ts";
import { SIX_STEP_CRITICAL_MUTATION_IDS, SIX_STEP_PREDICATE_SPEC } from "../src/spec.ts";
import { applySixStepQualificationMutation } from "../src/mutations.ts";
import {
  SIX_STEP_VALUATION_ORACLE_COMPOSITION_ROOT,
  SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES,
} from "../src/composition/valuation-oracle-manifest.ts";
import { SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST } from "../src/valuation-oracle.ts";
import { issueSixStepQualificationCorpusFixtureV1 } from "./qualification-authority-fixture.ts";

const qualifyOwnedSixStepCorpus = (positiveFixture: SixStepQualificationFixtureV1) =>
  qualifySixStepCorpus(issueSixStepQualificationCorpusFixtureV1(positiveFixture));

const h = (digit: string): Hash => (`0x${digit.repeat(64)}`) as Hash;
const process: ProcessAnchorV1 = {
  systemId: "six-step-test",
  commitSha: "a".repeat(40),
  executableHash: h("1"),
  deploymentManifestHash: h("2"),
  serviceIdentityHash: h("3"),
  pid: "42",
  processStartTicks: "100",
  bootIdHash: h("4"),
};
const cutoff = { number: "100", hash: h("5"), stateRoot: h("6") } as const;
const source = { chainId: "1", number: "101", hash: h("7"), stateRoot: h("8") } as const;
const catalog = h("a");
const instanceCatalog = h("b");
const graph = h("c");
const strategy = h("d");
const familyDefinition = h("e");
const capability = { capabilityId: "cap", version: "1.0.0", schemaHash: h("f"), interpreterHash: h("1") } as const;
const stageSchema = stageFactsSchemaRef();
const inputSchema = stageInputSchemaRef();
const resolverPolicy = createResolverPolicy({ schemaVersion: 1, kind: "aloha.artifact-resolver-policy", allowedLocatorKind: "content-object", digestAlgorithm: "sha256", maxByteLength: "100000", requireExactLengthMediaAndSchema: true, minimumRemainingStoreEpochs: "0", failureOutcome: "invalid" });
const qualificationProfitAsset = erc20AssetReferenceV1("1", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
const qualificationValuationOwnerRef = hashDomain("aloha/economic-safety/valuation-owner-ref/v1", {
  modulePath: "valuation-owners/native-equivalent/src/runtime.ts",
  exportName: "createNativeEquivalentValuationOwnerV1",
});
const qualificationValuationOwnerImplementationHash = hashDomain("aloha/economic-safety/valuation-owner-implementation/v1", {
  ownerRef: qualificationValuationOwnerRef,
  assetRef: qualificationProfitAsset.assetRef,
  semantics: "same-source-mainnet-wrapped-native-one-to-one-v1",
});
const qualificationValuationFactSchemaRef = hashDomain("aloha/economic-valuation-fact-schema/v1", {
  kind: "aloha.economic-valuation-fact-v1",
  semantics: "release-registry-qualified-current-source-owner-fact-v1",
});
const qualificationValuationImplementationClosureRoot = hashDomain("aloha/six-step/test-valuation-owner/v1", "implementation-closure");
const qualificationValuationLeafDigest = hashDomain("aloha/six-step/test-valuation-owner/v1", "qualification-leaf");
const qualificationValuationOwnerRegistryRoot = hashDomain("aloha/six-step/test-valuation-owner/v1", "registry");
const qualificationValuationOwnerSetRoot = hashDomain("aloha/six-step/test-valuation-owner/v1", "qualified-set");
const qualificationActionFamilyDefinitionHash = hashDomain("aloha/six-step/test-action/v1", "family");
const qualificationActionOwnerRef = hashDomain("aloha/six-step/test-action/v1", "owner");
const qualificationActionOwnerImplementationHash = hashDomain("aloha/six-step/test-action/v1", "implementation");
const qualificationActionSchemaRef = hashDomain("aloha/six-step/test-action/v1", "schema");
const qualificationActionImplementationClosureRoot = hashDomain("aloha/six-step/test-action/v1", "implementation-closure");
const qualificationActionLeafDigest = hashDomain("aloha/six-step/test-action/v1", "qualification-leaf");
const qualificationActionVerifierHash = hashDomain("aloha/six-step/test-action/v1", "verifier");
const qualificationExecutor = Object.freeze({
  executorKind: "revm" as const,
  engineBuildFingerprint: hashDomain("aloha/six-step/test-worker/v1", "engine-build"),
  executableFingerprint: hashDomain("aloha/six-step/test-worker/v1", "executable"),
  qualifiedExecutorRegistryRoot: hashDomain("aloha/six-step/test-worker/v1", "registry"),
  selectedExecutorLeafHash: hashDomain("aloha/six-step/test-worker/v1", "selected-leaf"),
  releaseRoleManifestRoot: hashDomain("aloha/six-step/test-worker/v1", "release-role-manifest"),
});

function evaluatorBindingObservation(
  releaseProvenanceHash: Hash,
  authorityRoot: Hash,
  implementationHash: Hash,
) {
  const objectiveTemplates = Object.freeze([Object.freeze({
    objectiveRef: h("2"),
    profitAsset: qualificationProfitAsset,
    profitAccount: "0x0000000000000000000000000000000000000002",
    minNetGain: "1000",
    maxGas: "1000000",
    maxValueAtRisk: "1000000000000000000",
    priorityFeePerGas: "2",
    bidCostNative: "300",
    valuationOwnerRef: qualificationValuationOwnerRef,
  })]);
  const actionOwners = Object.freeze([Object.freeze({
    familyDefinitionHash: qualificationActionFamilyDefinitionHash,
    ownerId: "qualification-action-owner",
    ownerRef: qualificationActionOwnerRef,
    implementationHash: qualificationActionOwnerImplementationHash,
    schemaRef: qualificationActionSchemaRef,
    implementationClosureRoot: qualificationActionImplementationClosureRoot,
    claimSchemaRefs: Object.freeze([qualificationActionSchemaRef]),
    qualificationLeafDigest: qualificationActionLeafDigest,
    verifierHash: qualificationActionVerifierHash,
  })]);
  const valuationOwners = Object.freeze([Object.freeze({
    ownerRef: qualificationValuationOwnerRef,
    implementationHash: qualificationValuationOwnerImplementationHash,
    factSchemaRef: qualificationValuationFactSchemaRef,
    implementationClosureRoot: qualificationValuationImplementationClosureRoot,
    qualificationLeafDigest: qualificationValuationLeafDigest,
    valuationOwnerRegistryRoot: qualificationValuationOwnerRegistryRoot,
    qualifiedValuationOwnerSetRoot: qualificationValuationOwnerSetRoot,
  })]);
  const safetyProfile = sealSafetyProfileV1({
    profileRef: hashDomain("aloha/six-step/test-action/v1", "safety-profile"),
    requiredClaims: Object.freeze([Object.freeze({
      claimSchemaRef: qualificationActionSchemaRef,
      ownerRef: qualificationActionOwnerRef,
      qualificationLeafDigest: qualificationActionLeafDigest,
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    })]),
    qualifiedOwnerSetRoot: hashDomain("aloha/six-step/test-action/v1", "qualified-owner-set"),
  });
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.six-step-economic-evaluator-binding-observation-v1" as const,
    runtimeBindingId: hashDomain("aloha/six-step/test-runtime-binding/v1", releaseProvenanceHash),
    candidateReleaseCommit: "a".repeat(40),
    releaseProvenanceHash,
    authorityRoot,
    implementationHash,
    policyRoot: hashDomain("aloha/runtime-release-economic-evaluator-policies/v4", {
      templates: objectiveTemplates,
      actionOwners,
      valuationOwners,
      executorQualification: qualificationExecutor,
      safetyProfile,
    }),
    evaluatorExportIdentityHash: hashDomain("aloha/six-step/test-economic-evaluator-export/v1", implementationHash),
    objectiveTemplates,
    actionOwners,
    valuationOwners,
    executorQualification: qualificationExecutor,
    safetyProfile,
  });
  return Object.freeze({ ...payload, observationRoot: hashDomain("aloha/six-step-economic-evaluator-binding-observation/v1", payload) });
}

class AppendMemory implements EvidenceAppendPortV1 {
  readonly events: EvidenceEventV1[] = [];
  async appendFsyncMonotonic(request: { sequence: string; eventId: Hash; contentSha256: Hash; bytes: Uint8Array }) {
    const event = decodeEvidenceEvent(request.bytes);
    this.events.push(event);
    const start = this.events.length === 1 ? 0 : this.events.slice(0, -1).reduce((sum, value) => sum + encodeEvidenceEvent(value).byteLength, 0);
    return {
      sequence: request.sequence,
      eventId: request.eventId,
      contentSha256: request.contentSha256,
      byteLength: String(request.bytes.byteLength),
      offsetStart: String(start),
      offsetEnd: String(start + request.bytes.byteLength),
      fsynced: true as const,
    };
  }
}

function contentRef(
  bytes: Uint8Array,
  index: number,
  locatorKind: "content-object" | "file-range" | "checkpoint-record" = "content-object",
): ReadOnlyArtifactRefV1 {
  const contentSha256 = sha256Hex(bytes);
  const lease = createRetentionLeaseReceipt({ storeIdentityHash: h("3"), objectKey: contentSha256, contentSha256, validFromStoreEpoch: "0", validThroughStoreEpoch: "10", issuerId: "observer", issuerQualificationId: h("1"), qualificationRegistryRoot: h("2") });
  const locator: ReadOnlyArtifactLocatorV1 = locatorKind === "file-range"
    ? {
      kind: "file-range",
      systemId: process.systemId,
      bootIdHash: process.bootIdHash,
      device: "1",
      inode: String(100 + index),
      startInclusive: "0",
      endExclusive: String(bytes.byteLength),
    }
    : locatorKind === "checkpoint-record"
      ? {
        kind: "checkpoint-record",
        storeIdentityHash: h("3"),
        namespaceHash: h("4"),
        keyHash: hashDomain("six-step/test-record-key/v1", index),
        revision: String(index),
        recordHash: hashDomain("six-step/test-record/v1", { index, contentSha256 }),
      }
      : {
        kind: "content-object",
        storeIdentityHash: h("3"),
        objectKey: contentSha256,
      };
  return createReadOnlyArtifactRef({
    locator,
    immutableMirrorLocator: { kind: "content-object", storeIdentityHash: h("3"), objectKey: contentSha256 },
    contentSha256,
    byteLength: String(bytes.byteLength),
    mediaType: "application/octet-stream",
    schema: null,
    resolverPolicyHash: resolverPolicy.policyHash,
    retentionLeaseReceiptId: lease.receiptId,
  });
}

interface BuiltWitness {
  readonly witness: SixStepEvidenceWitnessV1;
  readonly ref: ReadOnlyArtifactRefV1;
  readonly bytes: Uint8Array;
}

class WitnessFactory {
  readonly artifacts: BuiltWitness[] = [];

  create(stageId: SixStepStageId, role: string, payload: CanonicalJsonObject): SixStepEvidenceWitnessV1 {
    const content = {
      schemaVersion: 1,
      kind: "aloha.six-step-evidence-witness",
      stageId,
      role,
      payload,
    } satisfies SixStepWitnessContentV1;
    const bytes = encodeCanonicalBytes(content);
    const ref = contentRef(bytes, 20 + this.artifacts.length);
    const witness = { artifactRefId: ref.artifactRefId, contentRoot: hashSixStepWitnessContentRoot(content) } satisfies SixStepEvidenceWitnessV1;
    this.artifacts.push({ witness, ref, bytes });
    return witness;
  }

  shared(role: string): SixStepEvidenceWitnessV1 {
    const artifact = this.artifacts.find((entry) => {
      try {
        return decodeSixStepWitnessContent(entry.bytes).role === role;
      } catch {
        return false;
      }
    });
    if (artifact === undefined) throw new Error(`missing shared witness ${role}`);
    return artifact.witness;
  }
}

interface StageFactsBuild {
  readonly facts: SixStepStageFactsV1;
  readonly witnesses: readonly BuiltWitness[];
}

function makeStageFacts(
  stage: 1 | 2 | 3 | 4 | 5 | 6,
  factory: WitnessFactory,
  stage1Id = h("1"),
  stage2Id = h("2"),
): StageFactsBuild {
  const facts = (() => {
  switch (stage) {
    case 1: return {
      schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "universe_instance",
      candidatePartition: factory.create("universe_instance", "candidate-partition", { kind: "candidate-partition", familyId: "family", candidateKey: "candidate", cutoff }),
      instancePublication: factory.create("universe_instance", "instance-publication", { kind: "instance-publication", familyId: "family", instanceKey: "instance", familyDefinitionHash: familyDefinition }),
      identityProof: factory.create("universe_instance", "identity-proof", { kind: "identity-proof", familyId: "family", instanceKey: "instance", identity: "instance" }),
      sourceCoverage: factory.create("universe_instance", "source-coverage", { kind: "source-coverage", cutoff, from: "50", through: "100", familyId: "family" }),
    };
    case 2: return {
      schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "edge_ready_generation",
      instancePublication: factory.shared("instance-publication"),
      edge: factory.create("edge_ready_generation", "edge", { kind: "edge-catalog", edgeId: h("a"), generationId: "generation", instanceKey: "instance", graphRoot: graph }),
      coverage: factory.create("edge_ready_generation", "coverage", { kind: "source-coverage", generationId: "generation", cutoff }),
      promotionRevision: "1", generationId: "generation", attestationMode: "fresh",
      memoReuseProof: factory.create("edge_ready_generation", "memo-reuse-proof", { kind: "memo-reuse-proof", generationId: "generation", promotionRevision: "1", proof: "fresh-attestation" }),
    };
    case 3: {
      const bindings = [{ edgeId: h("a"), instanceKey: "instance", stage1EventId: stage1Id, stage2EventId: stage2Id, instancePublicationRoot: factory.shared("instance-publication").contentRoot }];
      return {
        schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "planner_consumption",
        orderedInstanceBindings: bindings, orderedInstanceBindingsRoot: hashOrderedInstanceBindingsRoot(bindings),
        routeSet: factory.create("planner_consumption", "route-set", { routeCandidateId: "candidate", orderedEdgeIds: [h("a")], routeHash: h("route") }),
        coarseProjection: factory.create("planner_consumption", "coarse-projection", { coarse: { kind: "rankable", routeHash: h("route"), source } }),
        admissionReceipt: factory.create("planner_consumption", "admission-receipt", { planned: { kind: "planned", routeHash: h("route"), source }, admissionClass: "ranked" }),
        admissionClass: "ranked",
      };
    }
    case 4: return {
      schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "current_source_exact",
      currentSource: source,
      exactOutput: factory.create("current_source_exact", "exact-output", { exact: { kind: "verified", routeHash: h("route"), routeBindingHash: h("2"), source, exactHash: h("exact") } }),
      fallback: false,
    };
    case 5: return {
      schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "execution_program",
      program: factory.create("execution_program", "program", { program: { kind: "execution-program", generationId: "generation", source, routeHash: h("route"), programBytes: "0xfixture", payloadHash: h("program-payload"), issuerRef: h("issuer"), obligationRoot: h("obligation"), programHash: h("program") } }),
      callerMode: "direct",
      preCalls: factory.create("execution_program", "pre-calls", { preCalls: [] }),
      observationPairs: factory.create("execution_program", "observation-pairs", { observationPairs: [] }),
      actionOwner: factory.create("execution_program", "action-owner", { actionOwners: [] }),
      fallback: false,
    };
    case 6: return {
      schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId: "final_simulation",
      finalSimulationReceipt: factory.create("final_simulation", "final-simulation-receipt", {
        simulation: { kind: "final-simulation-passed", generationId: "generation", source, programHash: h("program"), effectsHash: h("effects"), receiptHash: h("simulation-receipt") },
        ownerEvidence: { schemaVersion: 1, kind: "aloha.final-simulation-six-step-evidence-v1", correlationId: "correlation", generationId: "generation", source, programHash: h("program"), finalSimulationReceiptHash: h("simulation-receipt"), facts: { effectsHash: h("effects") }, evidenceRoot: h("final-evidence") },
      }),
      simulationSourceAnchor: source,
      economicReceipt: factory.create("final_simulation", "economic-receipt", { economic: { verdict: "positive-net-ev" } }),
      safetyReceipt: factory.create("final_simulation", "safety-receipt", { safety: { verdict: "safe" } }),
      dryRun: true,
    };
  }
  })() as unknown as SixStepStageFactsV1;
  const witnessRefs = (() => {
    switch (facts.stageId) {
      case "universe_instance": return [facts.candidatePartition, facts.instancePublication, facts.identityProof, facts.sourceCoverage];
      case "edge_ready_generation": return [facts.instancePublication, facts.edge, facts.coverage, facts.memoReuseProof];
      case "planner_consumption": return [facts.routeSet, facts.coarseProjection, facts.admissionReceipt];
      case "current_source_exact": return [facts.exactOutput];
      case "execution_program": return [facts.program, facts.preCalls, facts.observationPairs, facts.actionOwner];
      case "final_simulation": return [facts.finalSimulationReceipt, facts.economicReceipt, facts.safetyReceipt];
    }
  })();
  const witnesses = witnessRefs.map((witness) => {
    const artifact = factory.artifacts.find((entry) => entry.ref.artifactRefId === witness.artifactRefId);
    if (artifact === undefined) throw new TypeError(`missing witness artifact from stage ${stage}`);
    return artifact;
  });
  return { facts, witnesses };
}

interface BuiltEvidence {
  readonly event: EvidenceEventV1;
  readonly semantic: SemanticArtifactV1;
  readonly receipt: ProductionReceiptV1;
  readonly boundary: EvidenceBoundaryObjectV1;
  readonly witnesses: readonly BuiltWitness[];
  readonly eventRef: ReadOnlyArtifactRefV1;
  readonly semanticRef: ReadOnlyArtifactRefV1;
  readonly receiptRef: ReadOnlyArtifactRefV1;
  readonly logRef: ReadOnlyArtifactRefV1;
  readonly rawRef: ReadOnlyArtifactRefV1;
  readonly logBytes: Uint8Array;
  readonly rawBytes: Uint8Array;
}

async function buildEvidence(
  append: AppendMemory,
  stage: 1 | 2 | 3 | 4 | 5 | 6,
  parentEvents: readonly EvidenceEventV1[],
  sequence: number,
  stageBuild?: StageFactsBuild,
): Promise<BuiltEvidence> {
  const built = stageBuild ?? makeStageFacts(stage, new WitnessFactory());
  const facts = built.facts;
  const witnesses = built.witnesses;
  const outputHash = hashDomain("aloha/stage-output/v1", { stageId: facts.stageId, factSchema: stageSchema, facts, outcome: stage === 1 ? "verified" : "success", reasonCode: null });
  // The runtime identity is process-scoped and includes the log-range ref;
  // use one immutable range for the whole producer session.
  const logBytes = new TextEncoder().encode("log");
  const witnessPayload = (role: string): CanonicalJsonObject => {
    const witness = witnesses.find((entry) => decodeSixStepWitnessContent(entry.bytes).role === role);
    if (witness === undefined) throw new TypeError(`missing ${role} witness payload`);
    return decodeSixStepWitnessContent(witness.bytes).payload;
  };
  const rawPayload: CanonicalJsonObject = (() => {
    if (stage === 3) {
      const routeSet = witnessPayload("route-set");
      return { ...routeSet, routeBindingHash: h("2"), coarse: witnessPayload("coarse-projection").coarse, planned: witnessPayload("admission-receipt").planned, admissionClass: witnessPayload("admission-receipt").admissionClass } as CanonicalJsonObject;
    }
    if (stage === 4) return witnessPayload("exact-output");
    if (stage === 5) {
      const program = witnessPayload("program").program;
      const ownerFacts = { callerMode: "direct", preCalls: witnessPayload("pre-calls").preCalls, observationPairs: witnessPayload("observation-pairs").observationPairs, actionOwners: witnessPayload("action-owner").actionOwners };
      return { program, ownerEvidence: { correlationId: "correlation", generationId: "generation", source, routeHash: h("route"), exactHash: h("exact"), programHash: (program as CanonicalJsonObject).programHash, facts: ownerFacts }, callerMode: "direct" } as CanonicalJsonObject;
    }
    if (stage === 6) {
      const final = witnessPayload("final-simulation-receipt");
      const economic = witnessPayload("economic-receipt").economic;
      const safety = witnessPayload("safety-receipt").safety;
      return { program: { kind: "execution-program", generationId: "generation", source, routeHash: h("route"), programBytes: "0xfixture", payloadHash: h("program-payload"), issuerRef: h("issuer"), obligationRoot: h("obligation"), programHash: h("program") }, simulation: final.simulation, ownerEvidence: final.ownerEvidence, economicSafety: { economic, safety } } as CanonicalJsonObject;
    }
    return { stage: String(stage) };
  })();
  const rawBytes = encodeCanonicalBytes({ schemaVersion: 1, kind: "aloha.six-step-native-boundary-record", stageId: facts.stageId, role: "raw-boundary", payload: rawPayload });
  const logRef = contentRef(logBytes, 2, "file-range");
  const rawRef = contentRef(rawBytes, 3, "checkpoint-record");
  const orderedWitnessArtifactRefIds = witnesses.map((witness) => witness.ref.artifactRefId);
  const semantic = createSemanticArtifact({ schema: { id: "aloha.six-step.semantic", version: "1.0.0", schemaHash: h("f") }, inputArtifactIds: [rawRef.artifactRefId, ...orderedWitnessArtifactRefIds], dependencyClosureRoot: h("1"), canonicalPayloadHash: outputHash });
  const receipt = createProductionReceipt({ artifactId: semantic.artifactId, producer: process, logRangeArtifactRef: logRef, sourceAnchorHash: h("2"), startedMonotonicNs: String(1000 + sequence * 10), finishedMonotonicNs: String(1001 + sequence * 10), durationUs: "1", rawBoundaryArtifactRef: rawRef, semanticConfigDigest: h("3"), resourceMetricsHash: h("4") });
  const emitter = new ProductionEvidenceEmitterV1({ append, emitterKind: "native", emitterCodeHash: h("5") });
  const boundary = {
    semanticArtifact: semantic,
    productionReceipt: receipt,
    scope: stage === 1 ? { kind: "builder-run", builderRunId: "run", producerSessionId: null, generationId: null, generationRefreshPolicyHash: h("6") } : stage === 2 ? { kind: "ready-generation", builderRunId: "run", producerSessionId: null, generationId: "generation", generationRefreshPolicyHash: h("6") } : { kind: "producer-session", builderRunId: "run", producerSessionId: "session", generationId: "generation", generationRefreshPolicyHash: h("6") },
    correlationId: "correlation",
    runSequence: String(sequence),
    cutoff,
    definitionCatalogRoot: catalog,
    strategyCatalogRoot: stage <= 2 ? null : strategy,
    instanceCatalogRoot: stage === 1 ? null : instanceCatalog,
    graphRoot: stage === 1 ? null : graph,
    familyId: "family",
    candidateKey: "candidate",
    familyDefinitionHash: familyDefinition,
    capabilities: [capability],
    instanceKey: "instance",
    stage: { ordinal: stage, id: ["universe_instance", "edge_ready_generation", "planner_consumption", "current_source_exact", "execution_program", "final_simulation"][stage - 1] as never, version: 1 },
    inputSchema,
    inputs: { schemaVersion: 1, kind: "aloha.six-step-stage-input", stageId: facts.stageId, rawBoundaryArtifactRefId: rawRef.artifactRefId, orderedWitnessArtifactRefIds, parentEventIds: parentEvents.map((event) => event.eventId) },
    factSchema: stageSchema,
    facts,
    outcome: stage === 1 ? "verified" : "success",
    reasonCode: null,
    parentEvents: parentEvents.map((event) => ({ event })),
    extensions: [],
  } satisfies EvidenceBoundaryObjectV1;
  const eventEmission = await emitter.emit(boundary);
  const eventRef = contentRef(eventEmission.bytes, 4);
  const semanticRef = contentRef(encodeSemanticArtifact(semantic), 5);
  const receiptRef = contentRef(encodeProductionReceipt(receipt), 6);
  return { event: eventEmission.event, semantic, receipt, boundary, witnesses, eventRef, semanticRef, receiptRef, logRef, rawRef, logBytes, rawBytes };
}

function buildRuntime(entries: readonly BuiltEvidence[]): SixStepRuntimeFactsV1 {
  const allRefs: ReadOnlyArtifactRefV1[] = [];
  const allClaims = [];
  const allLeases = [];
  const policy = resolverPolicy;
  for (const entry of entries) {
    const refs = [entry.eventRef, entry.semanticRef, entry.receiptRef, entry.logRef, entry.rawRef, ...entry.witnesses.map((witness) => witness.ref)];
    const uniqueRefs = [...new Map(refs.map((ref) => [ref.artifactRefId, ref])).values()];
    for (const [index, ref] of uniqueRefs.entries()) {
      const witness = entry.witnesses.find((candidate) => candidate.ref.artifactRefId === ref.artifactRefId);
      const bytes = ref.artifactRefId === entry.eventRef.artifactRefId ? encodeEvidenceEvent(entry.event) : ref.artifactRefId === entry.semanticRef.artifactRefId ? encodeSemanticArtifact(entry.semantic) : ref.artifactRefId === entry.receiptRef.artifactRefId ? encodeProductionReceipt(entry.receipt) : ref.artifactRefId === entry.logRef.artifactRefId ? entry.logBytes : witness?.bytes ?? entry.rawBytes;
      const lease = createRetentionLeaseReceipt({ storeIdentityHash: ref.immutableMirrorLocator.storeIdentityHash, objectKey: ref.immutableMirrorLocator.objectKey, contentSha256: ref.contentSha256, validFromStoreEpoch: "0", validThroughStoreEpoch: "10", issuerId: "observer", issuerQualificationId: h("1"), qualificationRegistryRoot: h("2") });
      const claim = createArtifactResolutionClaim({ artifactRefId: ref.artifactRefId, resolverPolicyHash: policy.policyHash, observedMirror: { storeIdentityHash: ref.immutableMirrorLocator.storeIdentityHash, objectKey: ref.immutableMirrorLocator.objectKey, bytes: encodeArtifactBytes(bytes), contentSha256: ref.contentSha256, byteLength: String(bytes.byteLength), mediaType: ref.mediaType, schema: ref.schema }, outcome: "content-observed" });
      allRefs.push(ref);
      allLeases.push(lease);
      allClaims.push(claim);
    }
  }
  const refs = [...new Map(allRefs.map((ref) => [ref.artifactRefId, ref])).values()];
  const claims = [...new Map(allClaims.map((claim) => [claim.artifactRefId, claim])).values()];
  const leases = [...new Map(allLeases.map((lease) => [lease.receiptId, lease])).values()];
  const observations = [{
    observationId: hashDomain("test/observation/v1", refs.map((ref) => ref.artifactRefId)),
    rawArtifactRefs: refs,
    observedClaimIds: claims.map((claim) => claim.claimId),
  }];
  return { facts: entries.map((entry) => ({ schemaVersion: 1, kind: "aloha.six-step-event-fact", eventArtifactRefId: entry.eventRef.artifactRefId, semanticArtifactRefId: entry.semanticRef.artifactRefId, productionReceiptArtifactRefId: entry.receiptRef.artifactRefId } satisfies SixStepEventFactV1)), refs, claims, policies: [policy], leases, observations };
}

async function reemitWithFacts(
  base: BuiltEvidence,
  facts: CanonicalJsonObject,
): Promise<BuiltEvidence> {
  const outputHash = hashDomain("aloha/stage-output/v1", {
    stageId: base.boundary.stage.id,
    factSchema: base.boundary.factSchema,
    facts,
    outcome: base.boundary.outcome,
    reasonCode: base.boundary.reasonCode,
  });
  const semantic = createSemanticArtifact({
    schema: base.semantic.schema,
    inputArtifactIds: base.semantic.inputArtifactIds,
    dependencyClosureRoot: base.semantic.dependencyClosureRoot,
    canonicalPayloadHash: outputHash,
  });
  const receipt = createProductionReceipt({
    artifactId: semantic.artifactId,
    producer: base.receipt.producer,
    logRangeArtifactRef: base.receipt.logRangeArtifactRef,
    sourceAnchorHash: base.receipt.sourceAnchorHash,
    startedMonotonicNs: base.receipt.startedMonotonicNs,
    finishedMonotonicNs: base.receipt.finishedMonotonicNs,
    durationUs: base.receipt.durationUs,
    rawBoundaryArtifactRef: base.receipt.rawBoundaryArtifactRef,
    semanticConfigDigest: base.receipt.semanticConfigDigest,
    resourceMetricsHash: base.receipt.resourceMetricsHash,
  });
  const boundary = {
    ...base.boundary,
    semanticArtifact: semantic,
    productionReceipt: receipt,
    facts,
  } satisfies EvidenceBoundaryObjectV1;
  const emitter = new ProductionEvidenceEmitterV1({
    append: new AppendMemory(),
    emitterKind: "native",
    emitterCodeHash: h("5"),
  });
  const emission = await emitter.emit(boundary);
  return {
    ...base,
    event: emission.event,
    semantic,
    receipt,
    boundary,
    eventRef: contentRef(emission.bytes, 4),
    semanticRef: contentRef(encodeSemanticArtifact(semantic), 5),
    receiptRef: contentRef(encodeProductionReceipt(receipt), 6),
  };
}

async function positiveFixture(): Promise<{ runtime: SixStepRuntimeFactsV1; entries: BuiltEvidence[] }> {
  const append = new AppendMemory();
  const witnesses = new WitnessFactory();
  const stage1 = await buildEvidence(append, 1, [], 1, makeStageFacts(1, witnesses));
  const stage2 = await buildEvidence(append, 2, [stage1.event], 2, makeStageFacts(2, witnesses, stage1.event.eventId));
  const stage3 = await buildEvidence(append, 3, [stage2.event], 3, makeStageFacts(3, witnesses, stage1.event.eventId, stage2.event.eventId));
  const stage4 = await buildEvidence(append, 4, [stage3.event], 4, makeStageFacts(4, witnesses));
  const stage5 = await buildEvidence(append, 5, [stage4.event], 5, makeStageFacts(5, witnesses));
  const stage6 = await buildEvidence(append, 6, [stage5.event], 6, makeStageFacts(6, witnesses));
  const entries = [stage1, stage2, stage3, stage4, stage5, stage6];
  return { runtime: buildRuntime(entries), entries };
}

function qualificationFixture(
  fixture: Awaited<ReturnType<typeof positiveFixture>>,
): SixStepQualificationFixtureV1 {
  return {
    runtime: fixture.runtime,
    reference: {
      events: fixture.entries.map((entry) => entry.event),
      semanticArtifacts: fixture.entries.map((entry) => entry.semantic),
      productionReceipts: fixture.entries.map((entry) => entry.receipt),
      stageFacts: fixture.entries.map((entry) => decodeSixStepStageFacts(entry.event.facts)),
      evidence: {
        facts: fixture.runtime.facts,
        refs: fixture.runtime.refs,
        claims: fixture.runtime.claims,
        policies: fixture.runtime.policies,
        leases: fixture.runtime.leases,
        observations: fixture.runtime.observations,
      },
      economicEvaluatorBinding: evaluatorBindingObservation(h("1"), h("2"), h("3")),
    },
  };
}

async function realProductionCrossFamilyFixture(options: Readonly<{
  readonly reversePlannerEdges?: boolean;
  readonly spliceFinalEffects?: boolean;
  readonly spliceEffectTransport?: boolean;
  readonly corruptEconomicArithmetic?: boolean;
  readonly corruptEconomicReceiptRoot?: boolean;
  readonly spliceObligationReceipt?: boolean;
  readonly corruptRevmObservationRoot?: boolean;
  readonly spliceQualificationLeaf?: boolean;
}> = {}): Promise<SixStepQualificationFixtureV1> {
  const tail = createProductionSixStepTailFixture([]);
  const edgeIds = Object.freeze([h("1"), h("2")]);
  const productionSource = Object.freeze({ chainId: "1", number: "101", hash: h("7"), stateRoot: h("8") });
  const pipeline = Object.freeze({
    lease: Object.freeze({ binding: Object.freeze({
      generationId: "generation",
      readyRecordHash: h("3"),
      generationRefreshPolicyHash: h("4"),
      cutoff: Object.freeze({ chainId: "1", number: "100", hash: h("5"), stateRoot: h("6") }),
      definitionCatalogRoot: h("a"),
      instanceCatalogRoot: h("b"),
      graphRoot: h("c"),
    }) }),
    currentSource: Object.freeze({ sessionId: h("d"), source: productionSource }),
    correlationId: h("e"),
    routeCandidateId: h("f"),
    orderedEdgeIds: options.reversePlannerEdges ? Object.freeze([...edgeIds].reverse()) : edgeIds,
    callerId: "qualification-production-fixture",
  });
  const route = Object.freeze({
    routeHash: h("1"),
    routeBindingHash: h("2"),
    legs: Object.freeze([
      Object.freeze({ edgeId: edgeIds[0], ownerRef: h("3") }),
      Object.freeze({ edgeId: edgeIds[1], ownerRef: h("4") }),
    ]),
  });
  const timing = Object.freeze({ startedMonotonicNs: "1000", finishedMonotonicNs: "2000", durationUs: "1" });
  const coarse = Object.freeze({ kind: "rankable", routeHash: route.routeHash, source: productionSource, projectionHash: h("5") });
  const planned = Object.freeze({ kind: "planned", routeHash: route.routeHash, source: productionSource, planHash: h("6") });
  const exact = Object.freeze({ kind: "verified", routeHash: route.routeHash, routeBindingHash: route.routeBindingHash, source: productionSource, exactHash: h("7") });
  const actionObligation = hashDomain("aloha/six-step/test-action/v1", "obligation");
  const actionOwnerProofRoot = hashDomain("aloha/six-step/test-action/v1", "owner-proof");
  const actionOwnerRef = qualificationActionOwnerRef;
  const profitAccount = "0x0000000000000000000000000000000000000002" as const;
  const effectTransport = Object.freeze({
    caller: Object.freeze({ ref: Object.freeze({ kind: "observed-sender" as const }), executionMode: "top-level" as const }),
    preCalls: Object.freeze([]),
    observeTokenBalances: Object.freeze([
      Object.freeze({ token: "0x0000000000000000000000000000000000000001" as const, account: Object.freeze({ kind: "observed-sender" as const }) }),
    ]),
    observeLogs: true,
  });
  const program = Object.freeze({
    kind: "execution-program",
    generationId: "generation",
    source: productionSource,
    routeHash: route.routeHash,
    programBytes: "0xfixture",
    payloadHash: h("8"),
    issuerRef: h("9"),
    obligationRoot: hashDomain("aloha/search-runtime-obligation-root/v1", [actionObligation]),
    effectTransport,
    programHash: h("b"),
  });
  const executionFacts = Object.freeze({
    kind: "aloha.search-runtime.execution-program-owner-facts-v1",
    callerMode: effectTransport.caller.executionMode,
    preCalls: effectTransport.preCalls,
    observationPairs: effectTransport.observeTokenBalances,
    observeLogs: effectTransport.observeLogs,
    callSequence: Object.freeze([]),
    actionOwners: Object.freeze([Object.freeze({
      familyDefinitionHash: qualificationActionFamilyDefinitionHash,
      routeBindingHash: route.routeBindingHash,
      actionOwnerId: "qualification-action-owner",
      actionOwnerRef,
      actionHash: hashDomain("aloha/six-step/test-action/v1", "action"),
      actionArtifactHash: hashDomain("aloha/six-step/test-action/v1", "artifact"),
      exactEvaluationHash: exact.exactHash,
      payload: Object.freeze({ obligationRoot: actionObligation }),
      payloadHash: hashDomain("aloha/six-step/test-action/v1", "payload"),
      inputs: Object.freeze([Object.freeze({ assetRef: qualificationProfitAsset.assetRef, amount: "1000" })]),
      outputs: Object.freeze([Object.freeze({ assetRef: qualificationProfitAsset.assetRef, amount: "6000" })]),
      obligationRoot: actionObligation,
    })]),
    routeAssetReferences: Object.freeze([qualificationProfitAsset]),
    obligationRoot: program.obligationRoot,
    declaredObligations: Object.freeze([Object.freeze({ obligationRef: actionObligation, ownerRef: actionOwnerRef, policy: "must-satisfy" as const })]),
  });
  const executionOwnerEvidenceBody = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.execution-program-six-step-evidence-v1",
    correlationId: pipeline.correlationId,
    generationId: "generation",
    source: productionSource,
    routeHash: route.routeHash,
    exactHash: exact.exactHash,
    programHash: program.programHash,
    facts: executionFacts,
  });
  const executionOwnerEvidence = Object.freeze({ ...executionOwnerEvidenceBody, evidenceRoot: hashDomain("aloha/execution-program-six-step-evidence/v1", executionOwnerEvidenceBody) });
  const observeAccounts = Object.freeze([
    qualificationProfitAsset.identity.address!,
    profitAccount,
  ].sort());
  const workerCaller = Object.freeze({
    address: profitAccount,
    mode: "top-level" as const,
    observedSender: profitAccount,
    verifiedActors: Object.freeze({}),
  });
  const projection = Object.freeze({
    input: Object.freeze({ block: Object.freeze({ baseFeePerGas: "10" }) }),
    caller: workerCaller,
    observeAccounts,
    effectTransport,
  });
  const decodedEffects = Object.freeze({
    accounts: Object.freeze([]),
    before: Object.freeze({}),
    gasUsed: "100",
    output: "0x01",
    status: "returned",
    preCalls: Object.freeze([]),
    tokenBalancesBefore: Object.freeze([Object.freeze({
      token: qualificationProfitAsset.identity.address!,
      account: profitAccount,
      balance: "1000",
    })]),
    tokenBalancesAfter: Object.freeze([Object.freeze({
      token: qualificationProfitAsset.identity.address!,
      account: profitAccount,
      balance: "6000",
    })]),
  });
  const effectsBody = Object.freeze({
    format: "revm-effects-v1" as const,
    bytes: encodeCanonicalJson(decodedEffects),
    observedAccounts: observeAccounts,
  });
  const effects = Object.freeze({
    ...effectsBody,
    effectsHash: hashDomain("aloha/revm-effects-wire/v1", effectsBody),
  });
  const workerAuthority = Object.freeze({
    authorityRoot: hashDomain("aloha/six-step/test-worker/v1", "authority"),
    workerEpoch: "qualification-epoch",
    executorSessionHash: hashDomain("aloha/six-step/test-worker/v1", "session"),
  });
  const workerReceiptBody = Object.freeze({
    requestId: "qualification-request",
    workerEpoch: workerAuthority.workerEpoch,
    ownerRef: hashDomain("aloha/six-step/test-worker/v1", "owner"),
    generationId: "generation",
    attemptId: "qualification-attempt",
    authority: workerAuthority,
    inputHash: hashDomain("aloha/six-step/test-worker/v1", "input"),
    deadlineAtMs: 1000,
    source: productionSource,
    caller: workerCaller,
    observeAccounts,
    programHash: program.programHash,
    status: "returned" as const,
    output: decodedEffects.output,
    effects,
    effectTransport,
  });
  const workerReceipt = Object.freeze({
    ...workerReceiptBody,
    authorityRoot: workerAuthority.authorityRoot,
    executorSessionHash: workerAuthority.executorSessionHash,
    engine: "revm" as const,
    engineBuildFingerprint: qualificationExecutor.engineBuildFingerprint,
    executionReceiptHash: hashDomain("aloha/revm-execution-receipt/v1", workerReceiptBody),
  });
  const simulation = Object.freeze({
    kind: "final-simulation-passed",
    generationId: "generation",
    source: productionSource,
    programHash: program.programHash,
    effectsHash: effects.effectsHash,
    effectTransport: options.spliceEffectTransport
      ? Object.freeze({ ...effectTransport, observeLogs: false })
      : effectTransport,
    simulation: workerReceipt,
    receiptHash: hashDomain("aloha/six-step/test-final-simulation/v1", workerReceipt.executionReceiptHash),
  });
  const finalOwnerFacts = Object.freeze({
    kind: "aloha.qualified-final-simulation-owner-facts-v1",
    artifactProgramHash: program.programHash,
    wireProgramHash: workerReceipt.programHash,
    executorQualification: Object.freeze({
      engineBuildFingerprint: qualificationExecutor.engineBuildFingerprint,
      executableFingerprint: qualificationExecutor.executableFingerprint,
      qualifiedExecutorRegistryRoot: qualificationExecutor.qualifiedExecutorRegistryRoot,
      selectedExecutorLeafHash: qualificationExecutor.selectedExecutorLeafHash,
      releaseRoleManifestRoot: qualificationExecutor.releaseRoleManifestRoot,
    }),
    projection,
    workerReceipt: options.spliceFinalEffects
      ? Object.freeze({ ...workerReceipt, effects: Object.freeze({ ...effects, effectsHash: h("f") }) })
      : workerReceipt,
  });
  const finalOwnerEvidenceBody = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.final-simulation-six-step-evidence-v1",
    correlationId: pipeline.correlationId,
    generationId: "generation",
    source: productionSource,
    programHash: program.programHash,
    finalSimulationReceiptHash: simulation.receiptHash,
    facts: finalOwnerFacts,
  });
  const finalOwnerEvidence = Object.freeze({ ...finalOwnerEvidenceBody, evidenceRoot: hashDomain("aloha/final-simulation-six-step-evidence/v1", finalOwnerEvidenceBody) });
  const releaseProvenanceHash = h("1");
  const objectiveRef = h("2");
  const economicAuthorityRoot = hashDomain("aloha/six-step/economic-fixture/v1", "economic-safety-authority");
  const economicImplementationHash = hashDomain("aloha/six-step/economic-fixture/v1", "economic-safety-implementation");
  const economicEvaluatorBinding = evaluatorBindingObservation(releaseProvenanceHash, economicAuthorityRoot, economicImplementationHash);
  const economicInput = Object.freeze({
    releaseProvenanceHash,
    correlationId: pipeline.correlationId,
    generationId: "generation",
    source: productionSource,
    objectiveRef,
    exactHash: exact.exactHash,
    programHash: program.programHash,
    obligationRoot: program.obligationRoot,
    finalSimulationReceiptHash: simulation.receiptHash,
    effectsHash: simulation.effectsHash,
    executionOwnerEvidenceRoot: executionOwnerEvidence.evidenceRoot,
    finalSimulationOwnerEvidenceRoot: finalOwnerEvidence.evidenceRoot,
    dryRun: true,
    executionOwnerFacts: executionOwnerEvidence.facts as unknown as CanonicalJsonObject,
    finalSimulationOwnerFacts: finalOwnerEvidence.facts as unknown as CanonicalJsonObject,
    declaredObligations: executionFacts.declaredObligations,
  });
  const valuationFactBody = Object.freeze({
    kind: "aloha.economic-valuation-fact-v1" as const,
    ownerRef: qualificationValuationOwnerRef,
    generationId: "generation",
    source: productionSource,
    assetRef: qualificationProfitAsset.assetRef,
    numerator: "1",
    denominator: "1",
    ownerImplementationHash: qualificationValuationOwnerImplementationHash,
    valuationOwnerRegistryRoot: qualificationValuationOwnerRegistryRoot,
    qualifiedValuationOwnerSetRoot: qualificationValuationOwnerSetRoot,
    qualificationLeafDigest: qualificationValuationLeafDigest,
    currentSourceObservationRoot: hashDomain("aloha/economic-valuation-current-source-observation/no-read/v1", {
      generationId: "generation",
      source: productionSource,
      assetRef: qualificationProfitAsset.assetRef,
      reason: "mainnet-wrapped-native-is-native-numeraire",
    }),
  });
  const valuationFact = Object.freeze({
    ...valuationFactBody,
    factRoot: hashDomain("aloha/economic-valuation-fact/v1", valuationFactBody),
  });
  const action = executionFacts.actionOwners[0]!;
  const obligationProofBody = Object.freeze({
    familyDefinitionHash: action.familyDefinitionHash,
    routeBindingHash: action.routeBindingHash,
    actionOwnerId: action.actionOwnerId,
    actionOwnerRef: action.actionOwnerRef,
    actionHash: action.actionHash,
    actionArtifactHash: action.actionArtifactHash,
    exactEvaluationHash: action.exactEvaluationHash,
    executionReceiptHash: workerReceipt.executionReceiptHash,
    effectsHash: effects.effectsHash,
    ownerProofRoot: actionOwnerProofRoot,
  });
  const routeProof = Object.freeze({
    objectiveRef,
    actionHashes: Object.freeze([action.actionHash]),
    executionReceiptHash: workerReceipt.executionReceiptHash,
    effectsHash: effects.effectsHash,
    deltas: Object.freeze([Object.freeze({
      assetRef: qualificationProfitAsset.assetRef,
      before: "1000",
      after: "6000",
      delta: "5000",
    })]),
  });
  const safetyProfile = economicEvaluatorBinding.safetyProfile;
  const selectedRequiredClaims = safetyProfile.requiredClaims;
  const revmObservationRoot = hashDomain("aloha/economic-safety/revm-observation/v1", {
    schemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    executorQualification: qualificationExecutor,
    source: productionSource,
    executionReceiptHash: workerReceipt.executionReceiptHash,
    effectsHash: effects.effectsHash,
  });
  const issuedEconomicSafety = sealEconomicSafetyEvidenceV1({
    authorityRoot: economicAuthorityRoot,
    implementationHash: economicImplementationHash,
    releaseProvenanceHash,
    input: economicInput,
    decision: Object.freeze({
      economic: Object.freeze({
        kind: "aloha.economic-receipt-v1" as const,
        gasUsed: "100",
        nextBlockBaseFeePerGas: "10",
        priorityFeePerGas: "2",
        effectiveGasPrice: "12",
        gasCostNative: "1200",
        profitAsset: qualificationProfitAsset,
        grossProfitAmount: "5000",
        valuationNumerator: "1",
        valuationDenominator: "1",
        valuationFactRoot: valuationFact.factRoot,
        valuationFact,
        grossProfitNative: "5000",
        bidCostNative: "300",
        netProfitNative: "3500",
        minNetProfitNative: "1000",
        verdict: "positive-net-ev" as const,
      }),
      safety: Object.freeze({
        kind: "aloha.final-safety-receipt-v1" as const,
        obligationRoot: program.obligationRoot,
        obligationReceipts: Object.freeze([Object.freeze({
          schemaRef: qualificationActionSchemaRef,
          ownerRef: qualificationActionOwnerRef,
          qualificationLeafDigest: qualificationActionLeafDigest,
          verifierHash: qualificationActionVerifierHash,
          subjectRoot: actionObligation,
          proofRoot: hashDomain("aloha/economic-safety/action-obligation-proof/v1", obligationProofBody),
          outcome: "satisfied" as const,
        })]),
        safetyProfileRef: safetyProfile.profileRef,
        safetyProfileRoot: safetyProfile.profileCompositionRoot,
        selectedRequiredClaims,
        requiredClaimSetRoot: hashDomain("aloha/economic-safety-selected-required-claim-set/v1", selectedRequiredClaims),
        revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
        revmObservationRoot,
        assetConservationProofRoot: hashDomain("aloha/economic-safety/asset-conservation-proof/v1", routeProof),
        assetConservation: "satisfied" as const,
        verdict: "safe" as const,
      }),
    }),
  });
  let economicSafety = issuedEconomicSafety;
  if (options.corruptEconomicArithmetic || options.corruptEconomicReceiptRoot) {
    const { receiptRoot: _receiptRoot, ...economicBody } = economicSafety.economic;
    const corruptedEconomicBody = Object.freeze({
      ...economicBody,
      ...(options.corruptEconomicArithmetic ? { netProfitNative: "3499" } : {}),
    });
    const economic = Object.freeze({
      ...corruptedEconomicBody,
      receiptRoot: options.corruptEconomicReceiptRoot
        ? h("9")
        : hashDomain("aloha/economic-receipt/v1", corruptedEconomicBody),
    });
    const { evidenceRoot: _evidenceRoot, ...evidenceBody } = economicSafety;
    const body = Object.freeze({ ...evidenceBody, economic });
    economicSafety = Object.freeze({ ...body, evidenceRoot: hashDomain("aloha/economic-safety-finalization-evidence/v1", body) });
  }
  if (options.spliceObligationReceipt) {
    const receipts = economicSafety.safety.obligationReceipts.map((receipt, index) => {
      if (!options.spliceObligationReceipt || index !== 0) return receipt;
      const { receiptRoot: _receiptRoot, ...receiptBody } = receipt;
      const body = Object.freeze({ ...receiptBody, ownerRef: h("9") });
      return Object.freeze({ ...body, receiptRoot: hashDomain("aloha/safety-obligation-receipt/v1", body) });
    });
    const { receiptRoot: _safetyRoot, obligationReceiptSetRoot: _setRoot, ...safetyBody } = economicSafety.safety;
    const body = Object.freeze({
      ...safetyBody,
      obligationReceipts: Object.freeze(receipts),
      obligationReceiptSetRoot: hashDomain("aloha/safety-obligation-receipt-set/v1", receipts.map((receipt) => receipt.receiptRoot)),
    });
    const safety = Object.freeze({ ...body, receiptRoot: hashDomain("aloha/final-safety-receipt/v1", body) });
    const { evidenceRoot: _evidenceRoot, ...evidenceBody } = economicSafety;
    const rooted = Object.freeze({ ...evidenceBody, safety });
    economicSafety = Object.freeze({ ...rooted, evidenceRoot: hashDomain("aloha/economic-safety-finalization-evidence/v1", rooted) });
  }
  if (options.corruptRevmObservationRoot || options.spliceQualificationLeaf) {
    economicSafety = Object.freeze({
      ...economicSafety,
      safety: Object.freeze({
        ...economicSafety.safety,
        ...(options.corruptRevmObservationRoot ? { revmObservationRoot: h("9") } : {}),
        ...(options.spliceQualificationLeaf ? {
          obligationReceipts: economicSafety.safety.obligationReceipts.map(receipt => Object.freeze({
            ...receipt,
            qualificationLeafDigest: h("9"),
          })),
        } : {}),
      }),
    });
  }
  const stage3 = await tail.emitPlanner({ pipeline, route, coarse, planned, timing } as never);
  const stage4 = await tail.emitExact({ parent: stage3, pipeline, route, exact, timing } as never);
  const stage5 = await tail.emitExecutionProgram({ parent: stage4, pipeline, route, program, ownerEvidence: executionOwnerEvidence, timing } as never);
  const stage6 = await tail.emitFinalSimulation({ parent: stage5, pipeline, route, program, simulation, ownerEvidence: finalOwnerEvidence, economicSafety, timing } as never);
  const stage12 = tail.readStage12Parents(stage3);
  const materials = Object.freeze([
    ...stage12.stage1.map(readProductionSixStepArtifactMaterialV1),
    ...stage12.stage2.map(readProductionSixStepArtifactMaterialV1),
    readProductionSixStepArtifactMaterialV1(stage3),
    readProductionSixStepArtifactMaterialV1(stage4),
    readProductionSixStepArtifactMaterialV1(stage5),
    readProductionSixStepArtifactMaterialV1(stage6),
  ]);
  const stored = [...new Map(materials.flatMap((material) => [
    material.eventArtifact,
    material.semanticArtifactRef,
    material.productionReceiptRef,
    ...material.inputArtifacts,
  ]).map((artifact) => [artifact.ref.artifactRefId, artifact])).values()];
  const runtime: SixStepRuntimeFactsV1 = Object.freeze({
    facts: Object.freeze([...materials.map((material) => material.eventFact), economicEvaluatorBinding]),
    refs: Object.freeze(stored.map((artifact) => artifact.ref)),
    claims: Object.freeze(stored.map((artifact) => artifact.claim)),
    policies: Object.freeze([PRODUCTION_SIX_STEP_FIXTURE_RESOLVER_POLICY]),
    leases: Object.freeze([...new Map(stored.map((artifact) => [artifact.lease.receiptId, artifact.lease])).values()]),
    observations: Object.freeze([Object.freeze({
      observationId: h("3"),
      rawArtifactRefs: Object.freeze(stored.map((artifact) => artifact.ref)),
      observedClaimIds: Object.freeze(stored.map((artifact) => artifact.claim.claimId)),
    })]),
  });
  return Object.freeze({
    runtime,
    reference: Object.freeze({
      events: Object.freeze(materials.map((material) => material.event)),
      semanticArtifacts: Object.freeze(materials.map((material) => material.semanticArtifact)),
      productionReceipts: Object.freeze(materials.map((material) => material.productionReceipt)),
      stageFacts: Object.freeze(materials.map((material) => decodeSixStepStageFacts(material.event.facts))),
      evidence: Object.freeze({
        facts: Object.freeze(materials.map((material) => material.eventFact)),
        refs: runtime.refs,
        claims: runtime.claims,
        policies: runtime.policies,
        leases: runtime.leases,
        observations: runtime.observations,
      }),
      economicEvaluatorBinding,
    }),
  });
}

test("positive six-step facts form one exact DAG and agree with independent model", async () => {
  const fixture = await realProductionCrossFamilyFixture();
  const runtimeResult = evaluateSixStepPredicate(fixture.runtime);
  assert.equal(runtimeResult.verdict, "pass", JSON.stringify(runtimeResult.reasons));
  const reference = evaluateSixStepReferenceModel(fixture.reference);
  assert.equal(reference.verdict, "pass", JSON.stringify(reference.reasons));
});

test("real production bytes preserve an exact cross-Family two-leg route", async () => {
  const fixture = await realProductionCrossFamilyFixture();
  const stage2 = fixture.reference.events.filter((event) => event.stage.ordinal === 2);
  assert.equal(stage2.length, 2);
  assert.notEqual(stage2[0]!.familyId, stage2[1]!.familyId);
  const runtime = evaluateSixStepPredicate(fixture.runtime);
  const reference = evaluateSixStepReferenceModel(fixture.reference);
  assert.equal(runtime.verdict, "pass", JSON.stringify(runtime.reasons));
  assert.equal(reference.verdict, "pass", JSON.stringify(reference.reasons));
});

test("real producer reroots reject route, transport, economic, obligation and safety splices", async () => {
  for (const fixture of [
    await realProductionCrossFamilyFixture({ reversePlannerEdges: true }),
    await realProductionCrossFamilyFixture({ spliceEffectTransport: true }),
    await realProductionCrossFamilyFixture({ corruptEconomicArithmetic: true }),
    await realProductionCrossFamilyFixture({ corruptEconomicReceiptRoot: true }),
    await realProductionCrossFamilyFixture({ spliceObligationReceipt: true }),
    await realProductionCrossFamilyFixture({ corruptRevmObservationRoot: true }),
    await realProductionCrossFamilyFixture({ spliceFinalEffects: true }),
    await realProductionCrossFamilyFixture({ spliceQualificationLeaf: true }),
  ]) {
    assert.notEqual(evaluateSixStepPredicate(fixture.runtime).verdict, "pass");
    assert.notEqual(evaluateSixStepReferenceModel(fixture.reference).verdict, "pass");
  }
});

test("missing, forged and spliced event observations are invalid", async () => {
  const fixture = await positiveFixture();
  const missing = { ...fixture.runtime, facts: fixture.runtime.facts.slice(0, -1) };
  assert.equal(evaluateSixStepPredicate(missing).verdict, "invalid");
  const forged = { ...fixture.runtime, facts: [{ ...(fixture.runtime.facts[0] as object), expectedVerdict: "pass" }] };
  assert.equal(evaluateSixStepPredicate(forged).verdict, "invalid");
  const spliced = { ...fixture.runtime, facts: fixture.runtime.facts.map((fact, index) => index === 0 ? { ...(fact as SixStepEventFactV1), eventArtifactRefId: (fixture.runtime.facts[1] as SixStepEventFactV1).eventArtifactRefId } : fact) };
  assert.equal(evaluateSixStepPredicate(spliced).verdict, "invalid");
  const hostileBytes = {
    ...fixture.runtime,
    claims: fixture.runtime.claims.map((claim, index) => index === 0 && claim.observedMirror !== null
      ? { ...claim, observedMirror: { ...claim.observedMirror, bytes: "0xnot-hex" as never } }
      : claim),
  };
  assert.doesNotThrow(() => evaluateSixStepPredicate(hostileBytes));
  assert.equal(evaluateSixStepPredicate(hostileBytes).verdict, "invalid");
  const reference = qualificationFixture(fixture).reference;
  assert.doesNotThrow(() => evaluateSixStepReferenceModel({ ...reference, evidence: hostileBytes }));
  assert.equal(evaluateSixStepReferenceModel({ ...reference, evidence: hostileBytes }).verdict, "invalid");
});

test("fallback and final simulation mutation cannot pass", async () => {
  const fixture = await positiveFixture();
  const stage4 = fixture.entries[3]!;
  const stage4Facts = decodeSixStepStageFacts(stage4.event.facts);
  const fallbackFacts = { ...stage4Facts, fallback: true };
  const fallbackEntry = await reemitWithFacts(stage4, fallbackFacts);
  const fallbackEntries = fixture.entries.map((entry, index) => index === 3 ? fallbackEntry : entry);
  assert.equal(evaluateSixStepPredicate(buildRuntime(fallbackEntries)).verdict, "invalid");

  const finalEntry = fixture.entries[5]!;
  const finalFacts = decodeSixStepStageFacts(finalEntry.event.facts);
  const liveFacts = { ...finalFacts, dryRun: false };
  const liveEntry = await reemitWithFacts(finalEntry, liveFacts);
  const liveEntries = fixture.entries.map((entry, index) => index === 5 ? liveEntry : entry);
  assert.equal(evaluateSixStepPredicate(buildRuntime(liveEntries)).verdict, "invalid");
});

test("qualification certificate executes every declared mutation against both verdict paths", async () => {
  const fixture = await realProductionCrossFamilyFixture();
  const run = executeSixStepQualificationCorpus(fixture);
  assert.deepEqual(run.structuralErrors, [], JSON.stringify(run));
  assert.deepEqual(run.cases.filter((item) => item.mutationId !== null && item.runtimeVerdict !== item.referenceVerdict), [], JSON.stringify(run));
  const certificate = qualifyOwnedSixStepCorpus(fixture);
  assert.equal(certificate.verdict, "qualified", JSON.stringify({ run, certificate }));
  assertQualifiedSixStepCertificate(certificate);
  assert.equal(certificate.predicateSpecDigest, SIX_STEP_PREDICATE_SPEC.specDigest);
  assert.deepEqual(certificate.declaredCriticalMutationIds, [...SIX_STEP_CRITICAL_MUTATION_IDS].sort());
  assert.deepEqual(certificate.rejectedOrInvalidMutationIds, [...SIX_STEP_CRITICAL_MUTATION_IDS].sort());
  assert.throws(() => assertQualifiedSixStepCertificate({ ...certificate, positiveEvidenceRoot: h("9") }));
  assert.throws(() => assertQualifiedSixStepCertificate({ ...certificate, independentOracleCaseCount: "1" }));
  assert.throws(() => assertQualifiedSixStepCertificate({ ...certificate, evidenceRootSchemeDigest: h("9") }));
  assert.throws(() => assertQualifiedSixStepCertificate({ ...certificate, mutationRegistryImplementationDigest: h("9") }));
  assert.throws(() => assertQualifiedSixStepCertificate({ ...certificate, independentOracleCaseRoot: h("9") }));
  assert.throws(() => assertQualifiedSixStepCertificate({ ...certificate, extraVerdict: "pass" } as never));
  const positiveCase = Object.freeze({ ...certificate.positiveCase, runtimeVerdict: "invalid" as const });
  const outerRerooted = Object.freeze({
    ...certificate,
    positiveCase,
    positiveCaseRoot: hashDomain("aloha/six-step/qualification/positive-cases/v1", [encodeCanonicalJson(positiveCase)]),
  });
  const { schemaVersion: _schemaVersion, kind: _kind, certificateId: _certificateId, ...forgedPayload } = outerRerooted;
  const outerRerootedCertificate = Object.freeze({ ...outerRerooted, certificateId: hashDomain("aloha/six-step/verifier-qualification/v1", forgedPayload) });
  assert.throws(() => assertQualifiedSixStepCertificate(outerRerootedCertificate), /positive or mutation case set/);
  const valuationCertificate = sealSixStepValuationOwnerQualificationCertificateV1(
    certificate,
    {
      ownerRef: qualificationValuationOwnerRef,
      proposedOwnerLeafDigest: qualificationValuationLeafDigest,
      implementationHash: qualificationValuationOwnerImplementationHash,
      factSchemaRef: qualificationValuationFactSchemaRef,
      implementationClosureRoot: qualificationValuationImplementationClosureRoot,
      qualificationSpecDigest: hashDomain("aloha/six-step/test-valuation-certificate/v1", "qualification-spec"),
      qualificationSpecClosureRoot: hashDomain("aloha/six-step/test-valuation-certificate/v1", "qualification-spec-closure"),
      criticalMutationCorpusRoot: hashDomain("aloha/six-step/test-valuation-certificate/v1", "mutation-corpus"),
      criticalMutationCorpusClosureRoot: hashDomain("aloha/six-step/test-valuation-certificate/v1", "mutation-corpus-closure"),
      independentOracleCaseRoot: hashDomain("aloha/six-step/test-valuation-certificate/v1", "independent-oracle-cases"),
      independentOracleClosureRoot: hashDomain("aloha/six-step/test-valuation-certificate/v1", "independent-oracle-closure"),
    },
    {
      approvalId: hashDomain("aloha/six-step/test-valuation-certificate/v1", "approval"),
      approvalPayloadHash: hashDomain("aloha/six-step/test-valuation-certificate/v1", "approval-payload"),
    },
  );
  assert.equal(valuationCertificate.ownerRef, qualificationValuationOwnerRef);
  assert.equal(valuationCertificate.proposedOwnerLeafDigest, qualificationValuationLeafDigest);
  assert.match(valuationCertificate.certificateRoot, /^0x[0-9a-f]{64}$/);
  assert.throws(() => sealSixStepValuationOwnerQualificationCertificateV1(
    certificate,
    { ...valuationCertificate, ownerRef: hashDomain("aloha/six-step/test-valuation-certificate/v1", "unknown-owner") },
    {
      approvalId: hashDomain("aloha/six-step/test-valuation-certificate/v1", "second-approval"),
      approvalPayloadHash: hashDomain("aloha/six-step/test-valuation-certificate/v1", "second-approval-payload"),
    },
  ));
});

test("qualification does not accept caller-prebuilt mutation corpora", async () => {
  const fixture = await realProductionCrossFamilyFixture();
  const callerCorpus = Object.freeze({ base: fixture, mutationCases: Object.freeze([{ mutationId: "caller-case", fixture }]) });
  assert.throws(() => qualifySixStepCorpus(callerCorpus as never), /not issued by the package owner/);
  assert.throws(() => executeSixStepQualificationCorpus(callerCorpus as never));
});

test("package-owned mutation identities produce distinct malformed evidence roots", async () => {
  const fixture = await realProductionCrossFamilyFixture();
  const run = executeSixStepQualificationCorpus(fixture);
  assert.equal(new Set(run.cases.map((item) => item.evidenceRoot)).size, SIX_STEP_CRITICAL_MUTATION_IDS.length + 1);
});

test("load-bearing Stage 5/6 mutations replace physical artifact bytes and content identities", async () => {
  const fixture = await realProductionCrossFamilyFixture();
  const baseContent = new Set(fixture.runtime.refs.map(ref => ref.contentSha256));
  for (const mutationId of [
    "stage5-effect-transport-splice",
    "stage6-economic-arithmetic",
    "stage6-economic-receipt-root",
    "stage6-economic-valuation-owner-splice",
    "stage6-obligation-receipt-splice",
    "stage6-repayment-conservation-splice",
    "stage6-safety-route-proof-splice",
    "stage6-standing-position-proof-splice",
  ] as const) {
    const mutated = applySixStepQualificationMutation(fixture, mutationId);
    const changed = mutated.runtime.claims.filter(claim => claim.outcome === "content-observed"
      && claim.observedMirror !== null && !baseContent.has(claim.observedMirror.contentSha256));
    assert.ok(changed.length > 0, `${mutationId} did not replace a physical artifact`);
    for (const claim of changed) {
      const mirror = claim.observedMirror!;
      const bytes = decodeArtifactBytes(mirror.bytes);
      assert.equal(sha256Hex(bytes), mirror.contentSha256, `${mutationId} contentSha256`);
      assert.ok(!fixture.runtime.claims.some(base => base.outcome === "content-observed"
        && base.observedMirror !== null && base.observedMirror.bytes === mirror.bytes), `${mutationId} bytes unchanged`);
    }
  }
});

test("ordinary callers and structural clones cannot mint qualification certificates", async () => {
  const fixture = await realProductionCrossFamilyFixture();
  assert.throws(() => qualifySixStepCorpus(fixture as never), /not issued by the package owner/);
  const issued = issueSixStepQualificationCorpusFixtureV1(fixture);
  assert.throws(() => qualifySixStepCorpus(structuredClone(issued) as never), /not issued by the package owner/);
  assert.equal(qualifySixStepCorpus(issued).verdict, "qualified");
});

test("the positive-fixture issuer is test-only and absent from the production package surface", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    readonly exports: Readonly<Record<string, string>>;
  };
  assert.ok(Object.values(packageJson.exports).every((value) => !value.includes("qualification-corpus-owner")));
  const qualificationSource = readFileSync(new URL("../src/qualification.ts", import.meta.url), "utf8");
  assert.equal(qualificationSource.includes("issueTestOnlySixStepQualificationCorpusV1"), false);
  assert.doesNotMatch(qualificationSource, /export function qualifySixStepCorpus\([\s\S]{0,240}mutationCases/);
});

test("reference model implementation closure contains no six-step production decoder", () => {
  const source = readFileSync(new URL("../src/reference-model.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "decodeReadOnlyArtifactRef", "decodeEvidenceEvent", "decodeSemanticArtifact",
    "decodeProductionReceipt", "assertEvidenceEventMatchesReceipt",
    "decodeSixStepStageFacts", "decodeSixStepWitnessContent",
    "hashSixStepWitnessContentRoot", "hashOrderedInstanceBindingsRoot",
  ]) assert.equal(new RegExp(`\\b${forbidden}\\b`).test(source), false, forbidden);
  assert.equal(source.includes('from "./schema.ts"'), false);
  assert.equal(source.includes('from "./spec.ts"'), false);
});

test("valuation oracle leaves are isolated from generic dispatch and unrelated owners", () => {
  const nativeLeaf = SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES[0]!.qualificationLeafDigest;
  const unrelatedLeaf = hashDomain("aloha/six-step/valuation-oracle-qualification-leaf/v1", {
    ownerRef: hashDomain("aloha/six-step/test-unrelated-valuation-owner/v1", "owner"),
    predicateOracleProgramDescriptorDigest: hashDomain("aloha/six-step/test-unrelated-valuation-owner/v1", "predicate"),
    referenceOracleProgramDescriptorDigest: hashDomain("aloha/six-step/test-unrelated-valuation-owner/v1", "reference"),
  });
  const extendedRoot = hashDomain("aloha/six-step/valuation-oracle-composition/v1", [nativeLeaf, unrelatedLeaf]);
  assert.notEqual(extendedRoot, SIX_STEP_VALUATION_ORACLE_COMPOSITION_ROOT);
  assert.equal(SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES[0]!.qualificationLeafDigest, nativeLeaf);
  assert.equal(SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST, hashDomain(
    "aloha/six-step/valuation-oracle-generic-core/v1",
    {
      input: ["profitAsset", "descriptor", "fact", "generationId", "source"],
      dispatch: "exact-owner-ref-generated-bom",
      result: "boolean-no-producer-verdict",
    },
  ));
  const predicateSource = readFileSync(new URL("../src/predicate.ts", import.meta.url), "utf8");
  const referenceSource = readFileSync(new URL("../src/reference-model.ts", import.meta.url), "utf8");
  for (const source of [predicateSource, referenceSource]) {
    assert.doesNotMatch(source, /c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2/);
    assert.doesNotMatch(source, /mainnet-wrapped-native-is-native-numeraire/);
  }
});
