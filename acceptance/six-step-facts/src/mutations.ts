import {
  decodeArtifactBytes,
  encodeArtifactBytes,
  createArtifactResolutionClaim,
  createRetentionLeaseReceipt,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  createProductionReceipt,
  createReadOnlyArtifactRef,
  createSemanticArtifact,
  encodeProductionReceipt,
  encodeSemanticArtifact,
  type ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createEvidenceEvent,
  encodeEvidenceEvent,
  type EvidenceEventDraft,
  type EvidenceEventV1,
} from "../../../specs/evidence/src/index.ts";
import {
  decodeSixStepNativeBoundaryRecord,
  decodeSixStepStageFacts,
  decodeSixStepWitnessContent,
  encodeSixStepWitnessContent,
  hashSixStepWitnessContentRoot,
  type SixStepEventFactV1,
  type SixStepStageFactsV1,
} from "../../../specs/evidence/src/six-step.ts";
import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { SixStepRuntimeFactsV1 } from "./predicate.ts";
import type { SixStepQualificationFixtureV1 } from "./qualification.ts";
import { SIX_STEP_CRITICAL_MUTATION_IDS } from "./spec.ts";

export interface SixStepMutationDefinitionV1 {
  readonly mutationId: (typeof SIX_STEP_CRITICAL_MUTATION_IDS)[number];
  readonly requiredRuntimePath: string;
  readonly requiredReferenceReason: string;
  readonly targetStageOrdinal: number | null;
}

const TARGETS = Object.freeze({
  "catalog-root-splice": Object.freeze({ runtime: "$.planner-ready.definitionCatalogRoot", reference: "planner-ready-definitionCatalogRoot", stage: 3 }),
  "cutoff-splice": Object.freeze({ runtime: "$.planner-ready.cutoff", reference: "planner-ready-cutoff", stage: 3 }),
  "event-bytes-mutation": Object.freeze({ runtime: "$.tail.correlationId", reference: "tail-correlationId", stage: 3 }),
  "event-ref-splice": Object.freeze({ runtime: "$.predicateFacts[5].semanticInputs", reference: "semantic-input-closure", stage: 4 }),
  "missing-independent-observation": Object.freeze({ runtime: "$.observations.denominator", reference: "observation-denominator", stage: null }),
  "producer-verdict-injection": Object.freeze({ runtime: "$.predicateFacts[0].event.inputs", reference: "stage-input-decode", stage: 1 }),
  "production-receipt-splice": Object.freeze({ runtime: "$.predicateFacts[6].lineage", reference: "artifact-or-receipt-missing", stage: 5 }),
  "runtime-process-splice": Object.freeze({ runtime: "$.predicateFacts[6].receipt", reference: "production-receipt-binding", stage: 5 }),
  "semantic-artifact-splice": Object.freeze({ runtime: "$.predicateFacts[6].lineage", reference: "artifact-or-receipt-missing", stage: 5 }),
  "stage-ordinal-id-mismatch": Object.freeze({ runtime: "$.predicateFacts[5].event.bytes", reference: "input-decode", stage: 4 }),
  "stage-parent-id-mismatch": Object.freeze({ runtime: "$.predicateFacts[5].semanticInputs", reference: "semantic-input-closure", stage: 4 }),
  "stage-parent-output-mismatch": Object.freeze({ runtime: "$.tail[1].parent", reference: "tail-parent", stage: 4 }),
  "stage-scope-mismatch": Object.freeze({ runtime: "$.tail.scope", reference: "tail-scope", stage: 4 }),
  "stage1-stage2-omission": Object.freeze({ runtime: "$.predicateFacts[2].event.bytes", reference: "input-decode", stage: 2 }),
  "stage2-ready-root-mismatch": Object.freeze({ runtime: "$.planner-ready.graphRoot", reference: "planner-ready-graphRoot", stage: 2 }),
  "stage3-route-binding-order": Object.freeze({ runtime: "$.predicateFacts[4].semanticInputs", reference: "semantic-input-closure", stage: 3 }),
  "stage3-route-binding-root": Object.freeze({ runtime: "$.planner.orderedInstanceBindingsRoot", reference: "stage3-facts", stage: 3 }),
  "stage4-current-source-splice": Object.freeze({ runtime: "$.stage4.exactPayload", reference: "stage4-exact-payload", stage: 4 }),
  "stage4-fallback": Object.freeze({ runtime: "$.predicateFacts[5].event.facts", reference: "evidence-envelope-invalid", stage: 4 }),
  "stage5-fallback": Object.freeze({ runtime: "$.predicateFacts[6].event.facts", reference: "evidence-envelope-invalid", stage: 5 }),
  "stage5-observation-pair-splice": Object.freeze({ runtime: "$.predicateFacts[6].event.facts", reference: "evidence-envelope-invalid", stage: 5 }),
  "stage5-program-splice": Object.freeze({ runtime: "$.predicateFacts[6].event.facts", reference: "evidence-envelope-invalid", stage: 5 }),
  "stage5-effect-transport-splice": Object.freeze({ runtime: "$.stage5.programPayload", reference: "stage5-program-payload", stage: 5 }),
  "stage6-economic-arithmetic": Object.freeze({ runtime: "$.stage6.safetyPayload", reference: "stage6-safety-payload", stage: 6 }),
  "stage6-economic-receipt-root": Object.freeze({ runtime: "$.stage6.safetyPayload", reference: "stage6-safety-payload", stage: 6 }),
  "stage6-economic-splice": Object.freeze({ runtime: "$.predicateFacts[7].event.facts", reference: "evidence-envelope-invalid", stage: 6 }),
  "stage6-economic-valuation-owner-splice": Object.freeze({ runtime: "$.stage6.safetyPayload", reference: "stage6-safety-payload", stage: 6 }),
  "stage6-obligation-receipt-splice": Object.freeze({ runtime: "$.stage6.safetyPayload", reference: "stage6-safety-payload", stage: 6 }),
  "stage6-repayment-conservation-splice": Object.freeze({ runtime: "$.stage6.safetyPayload", reference: "stage6-safety-payload", stage: 6 }),
  "stage6-safety-route-proof-splice": Object.freeze({ runtime: "$.stage6.safetyPayload", reference: "stage6-safety-payload", stage: 6 }),
  "stage6-simulation-splice": Object.freeze({ runtime: "$.predicateFacts[7].event.facts", reference: "evidence-envelope-invalid", stage: 6 }),
  "stage6-standing-position-proof-splice": Object.freeze({ runtime: "$.stage6.safetyPayload", reference: "stage6-safety-payload", stage: 6 }),
  "stage6-standing-position-splice": Object.freeze({ runtime: "$.predicateFacts[7].event.facts", reference: "evidence-envelope-invalid", stage: 6 }),
} satisfies Record<(typeof SIX_STEP_CRITICAL_MUTATION_IDS)[number], Readonly<{ runtime: string; reference: string; stage: number | null }>>);

export const SIX_STEP_MUTATION_REGISTRY: readonly SixStepMutationDefinitionV1[] = Object.freeze(
  SIX_STEP_CRITICAL_MUTATION_IDS.map((mutationId) => Object.freeze({
    mutationId,
    requiredRuntimePath: TARGETS[mutationId].runtime,
    requiredReferenceReason: TARGETS[mutationId].reference,
    targetStageOrdinal: TARGETS[mutationId].stage,
  })),
);

export const SIX_STEP_MUTATION_REGISTRY_IMPLEMENTATION_DIGEST: Hash = hashDomain(
  "aloha/six-step/mutation-registry-program/v1",
  {
    interpreter: "package-owned-deterministic-mutator-v2",
    definitions: SIX_STEP_MUTATION_REGISTRY,
    input: "owner-issued-positive-base-only",
    mutationCasesInput: "forbidden",
    verdictInput: "forbidden",
    reroot: "event-semantic-receipt-and-downstream-event-closure-v1",
  },
);

export function resolveSixStepMutationDefinition(mutationId: string): SixStepMutationDefinitionV1 | null {
  return SIX_STEP_MUTATION_REGISTRY.find((entry) => entry.mutationId === mutationId) ?? null;
}

const mutationHash = (mutationId: string, role: string): Hash => hashDomain(
  "aloha/six-step/qualification-mutation-value/v1",
  { mutationId, role },
);

function eventDraft(event: EvidenceEventV1): EvidenceEventDraft {
  const { eventId: _eventId, capabilitySetHash: _capabilitySetHash, inputHash: _inputHash, outputHash: _outputHash, ...draft } = event;
  return draft;
}

function createQualificationEvent(draft: EvidenceEventDraft, allowStructurallyInvalid: boolean): EvidenceEventV1 {
  if (!allowStructurallyInvalid) return createEvidenceEvent(draft);
  const capabilitySetHash = hashDomain("aloha/capability-set/v1", draft.capabilities);
  const inputHash = hashDomain("aloha/stage-input/v1", { stageId: draft.stage.id, inputSchema: draft.inputSchema, inputs: draft.inputs });
  const outputHash = hashDomain("aloha/stage-output/v1", { stageId: draft.stage.id, factSchema: draft.factSchema, facts: draft.facts, outcome: draft.outcome, reasonCode: draft.reasonCode });
  const body = { ...draft, capabilitySetHash, inputHash, outputHash };
  return { ...body, eventId: hashDomain("aloha/evidence-event/v1", body) } as EvidenceEventV1;
}

function mutatedEventDraft(event: EvidenceEventV1, mutationId: string): EvidenceEventDraft {
  const base = eventDraft(event);
  const bad = mutationHash(mutationId, "bad-value");
  switch (mutationId) {
    case "catalog-root-splice": return { ...base, definitionCatalogRoot: bad };
    case "cutoff-splice": return { ...base, cutoff: { ...event.cutoff, number: (BigInt(event.cutoff.number) + 1n).toString() } };
    case "event-bytes-mutation": return { ...base, correlationId: `${event.correlationId}:mutated` };
    case "event-ref-splice": return { ...base, artifactLineage: { ...event.artifactLineage, inputArtifactIds: event.artifactLineage.inputArtifactIds.map((value, index) => index === 0 ? bad : value) } };
    case "production-receipt-splice": return { ...base, artifactLineage: { ...event.artifactLineage, productionReceiptId: bad } };
    case "runtime-process-splice": return { ...base, runtime: { ...event.runtime, executableHash: bad } };
    case "semantic-artifact-splice": return { ...base, artifactLineage: { ...event.artifactLineage, outputArtifactId: bad } };
    case "stage-ordinal-id-mismatch": return { ...base, stage: { ...event.stage, ordinal: event.stage.ordinal === 6 ? 5 : event.stage.ordinal + 1 } as EvidenceEventV1["stage"] };
    case "stage-parent-id-mismatch": return { ...base, parentEventIds: [bad] };
    case "stage-parent-output-mismatch": return { ...base, parentOutputHashes: event.parentOutputHashes.map(() => bad) };
    case "stage-scope-mismatch": return event.scope.kind === "producer-session"
      ? { ...base, scope: { ...event.scope, producerSessionId: `${event.scope.producerSessionId}:mutated` } }
      : { ...base, scope: { ...event.scope, builderRunId: `${event.scope.builderRunId}:mutated` } };
    case "stage1-stage2-omission": return { ...base, parentEventIds: [], parentOutputHashes: [] };
    case "stage2-ready-root-mismatch": return { ...base, graphRoot: bad };
    case "stage3-route-binding-order": return { ...base, inputs: { ...event.inputs, parentEventIds: [...event.parentEventIds].reverse() } };
    case "stage3-route-binding-root": return { ...base, facts: { ...event.facts, orderedInstanceBindingsRoot: bad } };
    case "stage4-current-source-splice": return { ...base, facts: { ...event.facts, currentSource: { ...(event.facts.currentSource as CanonicalJsonObject), hash: bad } } };
    case "stage4-fallback":
    case "stage5-fallback": return { ...base, facts: { ...event.facts, fallback: true } };
    case "stage5-observation-pair-splice": return { ...base, facts: { ...event.facts, observationPairs: null } };
    case "stage5-program-splice": return { ...base, facts: { ...event.facts, program: null } };
    case "stage6-economic-splice": return { ...base, facts: { ...event.facts, economicReceipt: null } };
    case "stage6-simulation-splice": return { ...base, facts: { ...event.facts, finalSimulationReceipt: null } };
    case "stage6-standing-position-splice": return { ...base, facts: { ...event.facts, standingPosition: null } };
    case "producer-verdict-injection": return { ...base, inputs: { ...event.inputs, expectedVerdict: "pass" } };
    default: throw new TypeError(`mutation ${mutationId} requires a physical artifact mutator`);
  }
}

interface MutableFixture {
  runtime: {
    facts: unknown[];
    refs: ReadOnlyArtifactRefV1[];
    claims: SixStepRuntimeFactsV1["claims"][number][];
    policies: SixStepRuntimeFactsV1["policies"][number][];
    leases: SixStepRuntimeFactsV1["leases"][number][];
    observations: Array<{
      observationId: SixStepRuntimeFactsV1["observations"][number]["observationId"];
      rawArtifactRefs: ReadOnlyArtifactRefV1[];
      observedClaimIds: Array<SixStepRuntimeFactsV1["observations"][number]["observedClaimIds"][number]>;
    }>;
  };
  events: EvidenceEventV1[];
  semanticArtifacts: SixStepQualificationFixtureV1["reference"]["semanticArtifacts"][number][];
  productionReceipts: SixStepQualificationFixtureV1["reference"]["productionReceipts"][number][];
  stageFacts: SixStepQualificationFixtureV1["reference"]["stageFacts"][number][];
  economicEvaluatorBinding: SixStepQualificationFixtureV1["reference"]["economicEvaluatorBinding"];
}

function mutableFixture(base: SixStepQualificationFixtureV1): MutableFixture {
  const clone = structuredClone(base) as SixStepQualificationFixtureV1;
  return {
    runtime: {
      facts: [...clone.runtime.facts], refs: [...clone.runtime.refs], claims: [...clone.runtime.claims],
      policies: [...clone.runtime.policies], leases: [...clone.runtime.leases],
      observations: clone.runtime.observations.map((value) => ({ observationId: value.observationId, rawArtifactRefs: [...value.rawArtifactRefs], observedClaimIds: [...value.observedClaimIds] })),
    },
    events: [...clone.reference.events], semanticArtifacts: [...clone.reference.semanticArtifacts],
    productionReceipts: [...clone.reference.productionReceipts], stageFacts: [...clone.reference.stageFacts],
    economicEvaluatorBinding: clone.reference.economicEvaluatorBinding,
  };
}

function replaceStoredBytes(state: MutableFixture, artifactRefId: Hash, bytes: Uint8Array): ReadOnlyArtifactRefV1 {
  const refIndex = state.runtime.refs.findIndex((value) => value.artifactRefId === artifactRefId);
  const oldRef = state.runtime.refs[refIndex];
  const claimIndex = state.runtime.claims.findIndex((value) => value.artifactRefId === artifactRefId);
  const oldClaim = state.runtime.claims[claimIndex];
  if (oldRef === undefined || oldClaim === undefined || oldClaim.observedMirror === null) throw new TypeError("mutation target artifact is not independently observed");
  const leaseIndex = state.runtime.leases.findIndex((value) => value.receiptId === oldRef.retentionLeaseReceiptId);
  const oldLease = state.runtime.leases[leaseIndex];
  if (oldLease === undefined) throw new TypeError("mutation target artifact lease is missing");
  const contentSha256 = sha256Hex(bytes);
  const lease = createRetentionLeaseReceipt({
    storeIdentityHash: oldLease.storeIdentityHash, objectKey: contentSha256, contentSha256,
    validFromStoreEpoch: oldLease.validFromStoreEpoch, validThroughStoreEpoch: oldLease.validThroughStoreEpoch,
    issuerId: oldLease.issuerId, issuerQualificationId: oldLease.issuerQualificationId,
    qualificationRegistryRoot: oldLease.qualificationRegistryRoot,
  });
  const locator = { kind: "content-object" as const, storeIdentityHash: oldLease.storeIdentityHash, objectKey: contentSha256 };
  const ref = createReadOnlyArtifactRef({
    locator, immutableMirrorLocator: locator, contentSha256, byteLength: String(bytes.byteLength),
    mediaType: oldRef.mediaType, schema: oldRef.schema, resolverPolicyHash: oldRef.resolverPolicyHash,
    retentionLeaseReceiptId: lease.receiptId,
  });
  const claim = createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId, resolverPolicyHash: oldClaim.resolverPolicyHash,
    observedMirror: { storeIdentityHash: oldLease.storeIdentityHash, objectKey: contentSha256, bytes: encodeArtifactBytes(bytes), contentSha256, byteLength: String(bytes.byteLength), mediaType: ref.mediaType, schema: ref.schema },
    outcome: "content-observed",
  });
  state.runtime.refs[refIndex] = ref;
  state.runtime.claims[claimIndex] = claim;
  state.runtime.leases[leaseIndex] = lease;
  for (const observation of state.runtime.observations) {
    observation.rawArtifactRefs = observation.rawArtifactRefs.map((value) => value.artifactRefId === artifactRefId ? ref : value);
    observation.observedClaimIds = observation.observedClaimIds.map((value) => value === oldClaim.claimId ? claim.claimId : value);
  }
  return ref;
}

function observedBytes(state: MutableFixture, artifactRefId: Hash): Uint8Array {
  const claim = state.runtime.claims.find(value => value.artifactRefId === artifactRefId);
  if (claim?.outcome !== "content-observed" || claim.observedMirror === null) {
    throw new TypeError("mutation target is not an observed physical artifact");
  }
  return decodeArtifactBytes(claim.observedMirror.bytes);
}

function replaceArtifactId(values: readonly Hash[], oldId: Hash, newId: Hash): readonly Hash[] {
  const replaced = values.map(value => value === oldId ? newId : value);
  if (!values.includes(oldId)) throw new TypeError("mutation target is outside the stage input closure");
  return Object.freeze(replaced);
}

function mutateWitnessArtifact(
  state: MutableFixture,
  eventIndex: number,
  witnessField: "program" | "economicReceipt" | "safetyReceipt",
  mutationId: string,
  mutatePayload: (payload: CanonicalJsonObject) => CanonicalJsonObject,
): void {
  const event = state.events[eventIndex]!;
  const facts = state.stageFacts[eventIndex]! as unknown as Readonly<Record<string, unknown>>;
  const witness = facts[witnessField] as Readonly<{ readonly artifactRefId: Hash; readonly contentRoot: Hash }> | undefined;
  if (witness === undefined) throw new TypeError(`mutation witness ${witnessField} is absent`);
  const content = decodeSixStepWitnessContent(observedBytes(state, witness.artifactRefId));
  const mutatedContent = Object.freeze({ ...content, payload: mutatePayload(content.payload) });
  const newRef = replaceStoredBytes(state, witness.artifactRefId, encodeSixStepWitnessContent(mutatedContent));
  const newFacts = Object.freeze({
    ...facts,
    [witnessField]: Object.freeze({
      artifactRefId: newRef.artifactRefId,
      contentRoot: hashSixStepWitnessContentRoot(mutatedContent),
    }),
  }) as unknown as SixStepStageFactsV1;
  const input = event.inputs as unknown as Readonly<Record<string, unknown>>;
  const orderedWitnessArtifactRefIds = input.orderedWitnessArtifactRefIds;
  if (!Array.isArray(orderedWitnessArtifactRefIds)) throw new TypeError("mutation stage witness order is absent");
  const draft = eventDraft(event);
  reissueStageAndDescendants(state, eventIndex, {
    ...draft,
    facts: newFacts as unknown as CanonicalJsonObject,
    inputs: {
      ...draft.inputs,
      orderedWitnessArtifactRefIds: replaceArtifactId(orderedWitnessArtifactRefIds as Hash[], witness.artifactRefId, newRef.artifactRefId),
    },
    artifactLineage: {
      ...draft.artifactLineage,
      inputArtifactIds: replaceArtifactId(draft.artifactLineage.inputArtifactIds, witness.artifactRefId, newRef.artifactRefId),
    },
  }, mutationId);
}

function mutateStage6RawBoundary(
  state: MutableFixture,
  eventIndex: number,
  mutationId: string,
  mutateBoundary: (boundary: CanonicalJsonObject) => CanonicalJsonObject,
): void {
  const event = state.events[eventIndex]!;
  const receipt = state.productionReceipts[eventIndex]!;
  const oldRefId = receipt.rawBoundaryArtifactRef.artifactRefId;
  const boundary = decodeSixStepNativeBoundaryRecord(observedBytes(state, oldRefId)) as unknown as CanonicalJsonObject;
  const newRef = replaceStoredBytes(state, oldRefId, encodeCanonicalBytes(mutateBoundary(boundary)));
  const draft = eventDraft(event);
  reissueStageAndDescendants(state, eventIndex, {
    ...draft,
    inputs: { ...draft.inputs, rawBoundaryArtifactRefId: newRef.artifactRefId },
    artifactLineage: {
      ...draft.artifactLineage,
      inputArtifactIds: replaceArtifactId(draft.artifactLineage.inputArtifactIds, oldRefId, newRef.artifactRefId),
    },
  }, mutationId);
}

function mutateStage6SafetyReceipt(
  state: MutableFixture,
  eventIndex: number,
  mutationId: string,
  mutateSafetyBody: (
    safetyBody: CanonicalJsonObject,
    economicSafety: CanonicalJsonObject,
  ) => CanonicalJsonObject,
): void {
  const event = state.events[eventIndex]!;
  const receipt = state.productionReceipts[eventIndex]!;
  const facts = state.stageFacts[eventIndex]! as unknown as Readonly<Record<string, unknown>>;
  const safetyWitness = facts.safetyReceipt as Readonly<{ readonly artifactRefId: Hash; readonly contentRoot: Hash }> | undefined;
  if (safetyWitness === undefined) throw new TypeError("stage6 safety receipt witness is absent");

  const oldBoundaryRefId = receipt.rawBoundaryArtifactRef.artifactRefId;
  const boundary = decodeSixStepNativeBoundaryRecord(observedBytes(state, oldBoundaryRefId)) as unknown as CanonicalJsonObject;
  const boundaryPayload = boundary.payload as CanonicalJsonObject;
  const economicSafety = boundaryPayload.economicSafety as CanonicalJsonObject;
  const oldSafety = economicSafety.safety as CanonicalJsonObject;
  const { receiptRoot: _oldSafetyRoot, ...oldSafetyBody } = oldSafety;
  const safetyBody = mutateSafetyBody(Object.freeze(oldSafetyBody), economicSafety);
  const safety = Object.freeze({
    ...safetyBody,
    receiptRoot: hashDomain("aloha/final-safety-receipt/v1", safetyBody),
  });
  const { evidenceRoot: _oldEvidenceRoot, ...oldEvidenceBody } = economicSafety;
  const evidenceBody = Object.freeze({ ...oldEvidenceBody, safety });
  const rerootedEconomicSafety = Object.freeze({
    ...evidenceBody,
    evidenceRoot: hashDomain("aloha/economic-safety-finalization-evidence/v1", evidenceBody),
  });
  const newBoundary = Object.freeze({
    ...boundary,
    payload: Object.freeze({ ...boundaryPayload, economicSafety: rerootedEconomicSafety }),
  });
  const newBoundaryRef = replaceStoredBytes(state, oldBoundaryRefId, encodeCanonicalBytes(newBoundary));

  const safetyContent = decodeSixStepWitnessContent(observedBytes(state, safetyWitness.artifactRefId));
  const newSafetyContent = Object.freeze({
    ...safetyContent,
    payload: Object.freeze({ ...safetyContent.payload, safety }),
  });
  const newSafetyRef = replaceStoredBytes(
    state,
    safetyWitness.artifactRefId,
    encodeSixStepWitnessContent(newSafetyContent),
  );
  const newFacts = Object.freeze({
    ...facts,
    safetyReceipt: Object.freeze({
      artifactRefId: newSafetyRef.artifactRefId,
      contentRoot: hashSixStepWitnessContentRoot(newSafetyContent),
    }),
  }) as unknown as SixStepStageFactsV1;
  const draft = eventDraft(event);
  const orderedWitnessArtifactRefIds = (draft.inputs as Readonly<Record<string, unknown>>).orderedWitnessArtifactRefIds;
  if (!Array.isArray(orderedWitnessArtifactRefIds)) throw new TypeError("stage6 witness order is absent");
  const replaceAll = (values: readonly Hash[]): readonly Hash[] => Object.freeze(values.map(value => {
    if (value === oldBoundaryRefId) return newBoundaryRef.artifactRefId;
    if (value === safetyWitness.artifactRefId) return newSafetyRef.artifactRefId;
    return value;
  }));
  reissueStageAndDescendants(state, eventIndex, {
    ...draft,
    facts: newFacts as unknown as CanonicalJsonObject,
    inputs: {
      ...draft.inputs,
      rawBoundaryArtifactRefId: newBoundaryRef.artifactRefId,
      orderedWitnessArtifactRefIds: replaceAll(orderedWitnessArtifactRefIds as readonly Hash[]),
    },
    artifactLineage: {
      ...draft.artifactLineage,
      inputArtifactIds: replaceAll(draft.artifactLineage.inputArtifactIds),
    },
  }, mutationId);
}

function mutateStage6SafetyRouteProof(
  state: MutableFixture,
  eventIndex: number,
  mutationId: string,
): void {
  mutateStage6SafetyReceipt(state, eventIndex, mutationId, (safetyBody, economicSafety) => {
    const finalOwnerFacts = economicSafety.finalSimulationOwnerFacts as CanonicalJsonObject;
    const workerReceipt = finalOwnerFacts.workerReceipt as CanonicalJsonObject;
    const forgedRouteProof = Object.freeze({
      objectiveRef: economicSafety.objectiveRef,
      actionHashes: Object.freeze([mutationHash(mutationId, "forged-action")]),
      executionReceiptHash: workerReceipt.executionReceiptHash,
      effectsHash: economicSafety.effectsHash,
      deltas: Object.freeze([]),
    });
    return Object.freeze({
      ...safetyBody,
      assetConservationProofRoot: hashDomain(
        "aloha/economic-safety/asset-conservation-proof/v1",
        forgedRouteProof,
      ),
    });
  });
}

function mutateStage6ValuationOwnerSplice(
  state: MutableFixture,
  eventIndex: number,
  mutationId: string,
): void {
  const event = state.events[eventIndex]!;
  const receipt = state.productionReceipts[eventIndex]!;
  const facts = state.stageFacts[eventIndex]! as unknown as Readonly<Record<string, unknown>>;
  const economicWitness = facts.economicReceipt as Readonly<{ readonly artifactRefId: Hash; readonly contentRoot: Hash }> | undefined;
  if (economicWitness === undefined) throw new TypeError("stage6 economic witness is absent");

  const oldBinding = state.economicEvaluatorBinding as unknown as CanonicalJsonObject;
  const oldTemplates = oldBinding.objectiveTemplates as readonly CanonicalJsonObject[];
  const oldOwners = oldBinding.valuationOwners as readonly CanonicalJsonObject[];
  if (!Array.isArray(oldTemplates) || oldTemplates.length === 0 || !Array.isArray(oldOwners) || oldOwners.length === 0) {
    throw new TypeError("valuation-owner mutation binding is incomplete");
  }
  const selectedOwner = oldOwners[0]!;
  const foreignOwnerRef = selectedOwner.ownerRef as Hash;
  const foreignImplementationHash = selectedOwner.implementationHash as Hash;
  const foreignSchemaRef = selectedOwner.factSchemaRef as Hash;
  const objectiveTemplates = Object.freeze(oldTemplates.map(template => Object.freeze({ ...template })));
  const valuationOwners = Object.freeze(oldOwners.map((owner, index) => index === 0
    ? Object.freeze({
      ...owner,
      ownerRef: foreignOwnerRef,
      implementationHash: foreignImplementationHash,
      factSchemaRef: foreignSchemaRef,
      qualificationLeafDigest: mutationHash(mutationId, "qualification-leaf"),
      valuationOwnerRegistryRoot: mutationHash(mutationId, "registry-root"),
      qualifiedValuationOwnerSetRoot: mutationHash(mutationId, "qualified-set-root"),
    })
    : owner));
  const policyRoot = hashDomain("aloha/runtime-release-economic-evaluator-policies/v4", {
    templates: objectiveTemplates,
    actionOwners: oldBinding.actionOwners,
    valuationOwners,
    executorQualification: oldBinding.executorQualification,
    safetyProfile: oldBinding.safetyProfile,
  });
  const { observationRoot: _oldObservationRoot, ...oldBindingPayload } = oldBinding;
  const bindingPayload = Object.freeze({ ...oldBindingPayload, policyRoot, objectiveTemplates, valuationOwners });
  const binding = Object.freeze({
    ...bindingPayload,
    observationRoot: hashDomain("aloha/six-step-economic-evaluator-binding-observation/v1", bindingPayload),
  });
  const bindingIndex = state.runtime.facts.findIndex(value => (value as Readonly<{ readonly kind?: unknown }>)?.kind === "aloha.six-step-economic-evaluator-binding-observation-v1");
  if (bindingIndex < 0) throw new TypeError("valuation-owner mutation binding observation is absent");
  state.runtime.facts[bindingIndex] = binding;
  state.economicEvaluatorBinding = binding as unknown as MutableFixture["economicEvaluatorBinding"];

  const oldBoundaryRefId = receipt.rawBoundaryArtifactRef.artifactRefId;
  const boundary = decodeSixStepNativeBoundaryRecord(observedBytes(state, oldBoundaryRefId)) as unknown as CanonicalJsonObject;
  const boundaryPayload = boundary.payload as CanonicalJsonObject;
  const economicSafety = boundaryPayload.economicSafety as CanonicalJsonObject;
  const oldEconomic = economicSafety.economic as CanonicalJsonObject;
  const oldValuationFact = oldEconomic.valuationFact as CanonicalJsonObject;
  const { factRoot: _oldFactRoot, ...oldValuationFactBody } = oldValuationFact;
  const valuationFactBody = Object.freeze({
    ...oldValuationFactBody,
    ownerRef: foreignOwnerRef,
    numerator: "2",
    denominator: "1",
    ownerImplementationHash: foreignImplementationHash,
    valuationOwnerRegistryRoot: (valuationOwners[0] as CanonicalJsonObject).valuationOwnerRegistryRoot,
    qualifiedValuationOwnerSetRoot: (valuationOwners[0] as CanonicalJsonObject).qualifiedValuationOwnerSetRoot,
    qualificationLeafDigest: (valuationOwners[0] as CanonicalJsonObject).qualificationLeafDigest,
    currentSourceObservationRoot: mutationHash(mutationId, "current-source-observation"),
  });
  const valuationFact = Object.freeze({
    ...valuationFactBody,
    factRoot: hashDomain("aloha/economic-valuation-fact/v1", valuationFactBody),
  });
  const { receiptRoot: _oldReceiptRoot, ...oldEconomicBody } = oldEconomic;
  const economicBody = Object.freeze({
    ...oldEconomicBody,
    valuationNumerator: "2",
    valuationDenominator: "1",
    valuationFactRoot: valuationFact.factRoot,
    valuationFact,
    grossProfitNative: "10000",
    netProfitNative: "8500",
    minNetProfitNative: "2000",
  });
  const economic = Object.freeze({
    ...economicBody,
    receiptRoot: hashDomain("aloha/economic-receipt/v1", economicBody),
  });
  const { evidenceRoot: _oldEvidenceRoot, ...oldEvidenceBody } = economicSafety;
  const evidenceBody = Object.freeze({ ...oldEvidenceBody, economic });
  const rerootedEconomicSafety = Object.freeze({
    ...evidenceBody,
    evidenceRoot: hashDomain("aloha/economic-safety-finalization-evidence/v1", evidenceBody),
  });
  const newBoundary = Object.freeze({
    ...boundary,
    payload: Object.freeze({ ...boundaryPayload, economicSafety: rerootedEconomicSafety }),
  });
  const newBoundaryRef = replaceStoredBytes(state, oldBoundaryRefId, encodeCanonicalBytes(newBoundary));

  const economicContent = decodeSixStepWitnessContent(observedBytes(state, economicWitness.artifactRefId));
  const newEconomicContent = Object.freeze({
    ...economicContent,
    payload: Object.freeze({ ...economicContent.payload, economic }),
  });
  const newEconomicRef = replaceStoredBytes(state, economicWitness.artifactRefId, encodeSixStepWitnessContent(newEconomicContent));
  const newFacts = Object.freeze({
    ...facts,
    economicReceipt: Object.freeze({
      artifactRefId: newEconomicRef.artifactRefId,
      contentRoot: hashSixStepWitnessContentRoot(newEconomicContent),
    }),
  }) as unknown as SixStepStageFactsV1;
  const draft = eventDraft(event);
  const orderedWitnessArtifactRefIds = (draft.inputs as Readonly<Record<string, unknown>>).orderedWitnessArtifactRefIds;
  if (!Array.isArray(orderedWitnessArtifactRefIds)) throw new TypeError("stage6 witness order is absent");
  const replaceAll = (values: readonly Hash[]): readonly Hash[] => Object.freeze(values.map(value => {
    if (value === oldBoundaryRefId) return newBoundaryRef.artifactRefId;
    if (value === economicWitness.artifactRefId) return newEconomicRef.artifactRefId;
    return value;
  }));
  reissueStageAndDescendants(state, eventIndex, {
    ...draft,
    facts: newFacts as unknown as CanonicalJsonObject,
    inputs: {
      ...draft.inputs,
      rawBoundaryArtifactRefId: newBoundaryRef.artifactRefId,
      orderedWitnessArtifactRefIds: replaceAll(orderedWitnessArtifactRefIds as readonly Hash[]),
    },
    artifactLineage: {
      ...draft.artifactLineage,
      inputArtifactIds: replaceAll(draft.artifactLineage.inputArtifactIds),
    },
  }, mutationId);
}

function reissueStageAndDescendants(state: MutableFixture, targetIndex: number, initialDraft: EvidenceEventDraft, mutationId: string): void {
  let previousOldEventId: Hash | null = null;
  let previousNewEvent: EvidenceEventV1 | null = null;
  for (let index = targetIndex; index < state.events.length; index += 1) {
    const oldEvent = state.events[index]!;
    const oldSemantic = state.semanticArtifacts[index]!;
    const oldReceipt = state.productionReceipts[index]!;
    let draft = index === targetIndex ? initialDraft : eventDraft(oldEvent);
    if (previousOldEventId !== null && previousNewEvent !== null) {
      const parentEventIds = draft.parentEventIds.map((value) => value === previousOldEventId ? previousNewEvent!.eventId : value);
      draft = {
        ...draft,
        parentEventIds,
        parentOutputHashes: oldEvent.parentEventIds.map((value, parentIndex) => value === previousOldEventId ? previousNewEvent!.outputHash : draft.parentOutputHashes[parentIndex]!),
        inputs: { ...draft.inputs, parentEventIds },
      };
    }
    const allowStructurallyInvalid = index === targetIndex && [
      "stage-ordinal-id-mismatch", "stage1-stage2-omission", "stage4-fallback", "stage5-fallback",
      "stage5-observation-pair-splice", "stage5-program-splice", "stage6-economic-splice",
      "stage6-simulation-splice", "stage6-standing-position-splice",
    ].includes(mutationId);
    const provisional = createQualificationEvent(draft, allowStructurallyInvalid);
    const injectedInputs = index === targetIndex
      ? provisional.artifactLineage.inputArtifactIds
      : oldSemantic.inputArtifactIds;
    const semantic = createSemanticArtifact({ schema: oldSemantic.schema, inputArtifactIds: injectedInputs, dependencyClosureRoot: oldSemantic.dependencyClosureRoot, canonicalPayloadHash: provisional.outputHash });
    const targetRawBoundaryRefId = index === targetIndex
      ? (draft.inputs as Readonly<Record<string, unknown>>).rawBoundaryArtifactRefId
      : null;
    const rawBoundaryArtifactRef = typeof targetRawBoundaryRefId === "string"
      ? state.runtime.refs.find(value => value.artifactRefId === targetRawBoundaryRefId)
      : oldReceipt.rawBoundaryArtifactRef;
    if (rawBoundaryArtifactRef === undefined) throw new TypeError("mutation raw boundary artifact is absent");
    const receipt = createProductionReceipt({
      artifactId: semantic.artifactId, producer: oldReceipt.producer, logRangeArtifactRef: oldReceipt.logRangeArtifactRef,
      sourceAnchorHash: oldReceipt.sourceAnchorHash, startedMonotonicNs: oldReceipt.startedMonotonicNs,
      finishedMonotonicNs: oldReceipt.finishedMonotonicNs, durationUs: oldReceipt.durationUs,
      rawBoundaryArtifactRef, semanticConfigDigest: oldReceipt.semanticConfigDigest,
      resourceMetricsHash: oldReceipt.resourceMetricsHash,
    });
    const event = createQualificationEvent({
      ...draft,
      artifactLineage: {
        inputArtifactIds: draft.artifactLineage.inputArtifactIds,
        outputArtifactId: index === targetIndex && mutationId === "semantic-artifact-splice" ? draft.artifactLineage.outputArtifactId : semantic.artifactId,
        productionReceiptId: index === targetIndex && mutationId === "production-receipt-splice" ? draft.artifactLineage.productionReceiptId : receipt.receiptId,
      },
    }, allowStructurallyInvalid);
    const fact = state.runtime.facts[index] as SixStepEventFactV1;
    const eventBytes = allowStructurallyInvalid ? encodeCanonicalBytes(event as unknown as CanonicalJsonObject) : encodeEvidenceEvent(event);
    const eventRef = replaceStoredBytes(state, fact.eventArtifactRefId, eventBytes);
    const semanticRef = replaceStoredBytes(state, fact.semanticArtifactRefId, encodeSemanticArtifact(semantic));
    const receiptRef = replaceStoredBytes(state, fact.productionReceiptArtifactRefId, encodeProductionReceipt(receipt));
    state.runtime.facts[index] = { ...fact, eventArtifactRefId: eventRef.artifactRefId, semanticArtifactRefId: semanticRef.artifactRefId, productionReceiptArtifactRefId: receiptRef.artifactRefId };
    state.events[index] = event;
    state.semanticArtifacts[index] = semantic;
    state.productionReceipts[index] = receipt;
    try { state.stageFacts[index] = decodeSixStepStageFacts(event.facts); } catch { /* Structural invalidity is the mutation's intended fact. */ }
    previousOldEventId = oldEvent.eventId;
    previousNewEvent = event;
  }
}

function freezeFixture(state: MutableFixture): SixStepQualificationFixtureV1 {
  const runtime: SixStepRuntimeFactsV1 = Object.freeze({
    facts: Object.freeze(state.runtime.facts), refs: Object.freeze(state.runtime.refs), claims: Object.freeze(state.runtime.claims),
    policies: Object.freeze(state.runtime.policies), leases: Object.freeze(state.runtime.leases),
    observations: Object.freeze(state.runtime.observations.map((value) => Object.freeze({ observationId: value.observationId, rawArtifactRefs: Object.freeze(value.rawArtifactRefs), observedClaimIds: Object.freeze(value.observedClaimIds) }))),
  });
  const evidence = Object.freeze({ ...runtime, facts: Object.freeze(state.runtime.facts.filter(value => (value as { readonly kind?: unknown })?.kind !== "aloha.six-step-economic-evaluator-binding-observation-v1")) });
  return Object.freeze({
    runtime,
    reference: Object.freeze({ events: Object.freeze(state.events), semanticArtifacts: Object.freeze(state.semanticArtifacts), productionReceipts: Object.freeze(state.productionReceipts), stageFacts: Object.freeze(state.stageFacts), evidence, economicEvaluatorBinding: state.economicEvaluatorBinding }),
  });
}

/** The only mutation interpreter. It accepts one positive fixture and a fixed
 * registry identity; callers can never provide mutated evidence or code. */
export function applySixStepQualificationMutation(
  base: SixStepQualificationFixtureV1,
  mutationId: (typeof SIX_STEP_CRITICAL_MUTATION_IDS)[number],
): SixStepQualificationFixtureV1 {
  const definition = resolveSixStepMutationDefinition(mutationId);
  if (definition === null) throw new TypeError(`unknown six-step qualification mutation: ${mutationId}`);
  const state = mutableFixture(base);
  if (mutationId === "missing-independent-observation") {
    state.runtime.observations = state.runtime.observations.slice(1);
    return freezeFixture(state);
  }
  const eventIndex = state.events.findIndex((event) => event.stage.ordinal === definition.targetStageOrdinal);
  if (eventIndex < 0) throw new TypeError(`mutation ${mutationId} target stage is absent`);
  if (mutationId === "stage5-effect-transport-splice") {
    mutateWitnessArtifact(state, eventIndex, "program", mutationId, payload => {
      const program = payload.program as CanonicalJsonObject;
      const effectTransport = program.effectTransport as CanonicalJsonObject;
      return Object.freeze({
        ...payload,
        program: Object.freeze({
          ...program,
          effectTransport: Object.freeze({ ...effectTransport, observeLogs: effectTransport.observeLogs !== true }),
        }),
      });
    });
    return freezeFixture(state);
  }
  if (mutationId === "stage6-economic-arithmetic" || mutationId === "stage6-economic-receipt-root") {
    mutateWitnessArtifact(state, eventIndex, "economicReceipt", mutationId, payload => {
      const economic = payload.economic as CanonicalJsonObject;
      return Object.freeze({
        ...payload,
        economic: Object.freeze({
          ...economic,
          ...(mutationId === "stage6-economic-arithmetic"
            ? { netProfitNative: (BigInt(economic.netProfitNative as string) + 1n).toString(10) }
            : { receiptRoot: mutationHash(mutationId, "receipt-root") }),
        }),
      });
    });
    return freezeFixture(state);
  }
  if (mutationId === "stage6-economic-valuation-owner-splice") {
    mutateStage6ValuationOwnerSplice(state, eventIndex, mutationId);
    return freezeFixture(state);
  }
  if (mutationId === "stage6-repayment-conservation-splice") {
    mutateStage6SafetyReceipt(state, eventIndex, mutationId, safetyBody => Object.freeze({
      ...safetyBody,
      assetConservationProofRoot: mutationHash(mutationId, "asset-conservation-proof"),
    }));
    return freezeFixture(state);
  }
  if (mutationId === "stage6-safety-route-proof-splice") {
    mutateStage6SafetyRouteProof(state, eventIndex, mutationId);
    return freezeFixture(state);
  }
  if (mutationId === "stage6-standing-position-proof-splice") {
    mutateStage6SafetyReceipt(state, eventIndex, mutationId, safetyBody => {
      const requiredClaims = safetyBody.selectedRequiredClaims as readonly CanonicalJsonObject[];
      if (!Array.isArray(requiredClaims) || requiredClaims.length === 0) {
        throw new TypeError("stage6 selected safety claims are absent");
      }
      const selectedRequiredClaims = Object.freeze(requiredClaims.map((claim, index) => index === 0
        ? Object.freeze({
          ...claim,
          qualificationLeafDigest: mutationHash(mutationId, "qualification-leaf"),
        })
        : claim));
      return Object.freeze({
        ...safetyBody,
        selectedRequiredClaims,
        requiredClaimSetRoot: hashDomain(
          "aloha/economic-safety-selected-required-claim-set/v1",
          selectedRequiredClaims,
        ),
      });
    });
    return freezeFixture(state);
  }
  if (mutationId === "stage6-obligation-receipt-splice") {
    mutateStage6RawBoundary(state, eventIndex, mutationId, boundary => {
      const payload = boundary.payload as CanonicalJsonObject;
      const economicSafety = payload.economicSafety as CanonicalJsonObject;
      const safety = economicSafety.safety as CanonicalJsonObject;
      const receipts = safety.obligationReceipts as readonly CanonicalJsonObject[];
      if (!Array.isArray(receipts) || receipts.length === 0) throw new TypeError("mutation obligation receipt is absent");
      return Object.freeze({
        ...boundary,
        payload: Object.freeze({
          ...payload,
          economicSafety: Object.freeze({
            ...economicSafety,
            safety: Object.freeze({
              ...safety,
              obligationReceipts: Object.freeze(receipts.map((receipt, index) => index === 0
                ? Object.freeze({ ...receipt, ownerRef: mutationHash(mutationId, "owner") })
                : receipt)),
            }),
          }),
        }),
      });
    });
    return freezeFixture(state);
  }
  reissueStageAndDescendants(state, eventIndex, mutatedEventDraft(state.events[eventIndex]!, mutationId), mutationId);
  return freezeFixture(state);
}

export function buildSixStepQualificationMutationCases(
  base: SixStepQualificationFixtureV1,
): readonly Readonly<{ mutationId: (typeof SIX_STEP_CRITICAL_MUTATION_IDS)[number]; fixture: SixStepQualificationFixtureV1 }>[] {
  return Object.freeze(SIX_STEP_CRITICAL_MUTATION_IDS.map((mutationId) => Object.freeze({ mutationId, fixture: applySixStepQualificationMutation(base, mutationId) })));
}
