import {
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  readFinalDurableWindowBindingV1,
  type FinalDurableWindowCapabilityV1,
} from "../../../packages/final-durable-window/src/index.ts";
import {
  readRuntimeReleaseFullFamilyTerminalBindingV1,
  type RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  type RuntimeReleaseFullFamilyTerminalBindingV1,
} from "../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts";
import {
  readRuntimeReleaseFullGraphCoarseSweepManifestV1,
  type FullGraphCoarseSweepCapabilityV1,
} from "../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts";
import type { ProductionFullFamilyObservationResultCapabilityV1 } from "../../../packages/full-family-observation-port/src/index.ts";
import type { ProductionSixStepObservationResultCapabilityV1 } from "../../../packages/six-step-observation-port/src/index.ts";
import type { ProductionTerminalPhaseObservationPortV1 } from "../../../packages/terminal-phase-observation-port/src/index.ts";
import {
  issueProductionTerminalPhaseObservationPortV1,
  readProductionTerminalPhaseObservationResultV1,
} from "../../../packages/terminal-phase-observation-port/src/internal/owner.ts";
import type { SchemaRef } from "../../../specs/core-envelope/src/index.ts";
import { sourcePlanIdentity } from "../../../packages/discovery/src/index.ts";
import type { ProductionSixStepStoredArtifactV1 } from "../../../packages/evidence-emitter/src/index.ts";
import { referencedFullFamilyArtifactDigests } from "../../../specs/full-family-facts/src/index.ts";
import type { ProductionFullFamilyObserverResultV1 } from "./full-family-observer.ts";
import { ContentAddressedObserverSinkV1, type ObservedContentArtifactV1 } from "./content-addressed-sink.ts";
import {
  readProductionFullFamilyCollectorResultV1,
} from "./production-full-family-port.ts";
import {
  readProductionSixStepCollectorResultV1,
} from "./production-six-step-port.ts";
import type { ProductionSixStepObserverResultV1 } from "./six-step-observer.ts";
import { ProductionTerminalPhaseLocatorIndexV1 } from "./terminal-phase-locator-index.ts";
import { createProductionTerminalPhaseFullFamilyProjectionV1 } from "./terminal-phase-full-family-projection.ts";
import { TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS } from "../../terminal-selection-facts/src/schema.ts";

function localSchema(id: string, descriptor: unknown): SchemaRef {
  const version = "1.0.0";
  return Object.freeze({ id, version, schemaHash: hashDomain("aloha/schema-definition/v1", { id, version, descriptor }) });
}

const TERMINAL_MANIFEST_SCHEMA = TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest;
const FULL_FAMILY_PROJECTION_SCHEMA = localSchema("aloha.production-terminal-phase-full-family-projection", {
  exactKind: "aloha.production-terminal-phase-full-family-projection-v1",
});
const TERMINAL_LOCATOR_SCHEMA = localSchema("aloha.production-terminal-phase-locator", {
  exactKind: "aloha.production-terminal-phase-locator-v1",
});

export interface ProductionTerminalPhaseManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.production-terminal-phase-manifest-v1";
  readonly finalDurableWindowId: Hash;
  readonly windowId: Hash;
  readonly releaseAnchorRoot: Hash;
  readonly runtimeAnchorRoot: Hash;
  readonly runtimeArtifactRoot: Hash;
  readonly processAnchorRoot: Hash;
  readonly fullGraphCoarseSweepRoot: Hash;
  readonly terminalPhaseInvocationRoot: Hash;
  readonly fullFamily: Readonly<{
    readonly projectionArtifactRefId: Hash;
    readonly projectionContentSha256: Hash;
  }>;
  readonly sixStep: Readonly<{
    readonly status: ProductionSixStepObserverResultV1["status"];
    readonly observationRoot: Hash;
    readonly windowSelectionRoot: Hash | null;
    readonly selectionPolicyDigest: Hash | null;
    readonly eligibleSuccessCount: string | null;
    readonly eligibleSuccessRoot: Hash | null;
    readonly selectedIndex: "0" | null;
    readonly selectedProducerTerminalId: Hash | null;
    readonly reason: string | null;
    readonly joinedProcessEvidenceRoot: Hash | null;
    readonly performanceAppendRecordId: Hash | null;
    readonly producerTerminalAppendRecordId: Hash | null;
    readonly predicateArtifactCount: string;
    readonly predicateArtifactRoot: Hash;
    readonly eventArtifactRefIds: readonly Hash[];
  }>;
  readonly manifestRoot: Hash;
}

export interface ProductionTerminalPhaseLocatorV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.production-terminal-phase-locator-v1";
  readonly finalDurableWindowId: Hash;
  readonly terminalPhaseInvocationRoot: Hash;
  readonly manifestRoot: Hash;
  readonly manifestArtifactRefId: Hash;
  readonly manifestContentSha256: Hash;
  readonly locatorRoot: Hash;
}

export interface ProductionTerminalPhaseCollectorResultV1 {
  readonly manifest: ProductionTerminalPhaseManifestV1;
  readonly manifestArtifact: ObservedContentArtifactV1;
  readonly fullFamilyProjectionArtifact: ObservedContentArtifactV1;
  readonly locator: ProductionTerminalPhaseLocatorV1;
  readonly locatorArtifact: ObservedContentArtifactV1;
  readonly selectedProcessArtifact: ObservedContentArtifactV1 | null;
  readonly locatorIndexRoot: Hash;
}

/**
 * Exact terminal join between inert release-artifact observations and the
 * release owner's generated runtime projection. A complete-looking release
 * object is not sufficient: every production denominator must equal the
 * metadata sealed into this exact final-head binding.
 */
export function assertProductionTerminalPhaseReleaseMetadataV1(
  resultValue: unknown,
  terminal: RuntimeReleaseFullFamilyTerminalBindingV1,
  finalWindow: ReturnType<typeof readFinalDurableWindowBindingV1>,
): void {
  if (resultValue === null || typeof resultValue !== "object") {
    throw new TypeError("terminal-phase Full-Family result is incomplete");
  }
  const result = resultValue as ProductionFullFamilyObserverResultV1;
  const release = result.release;
  const globalDefinitionCatalog = release?.globalDefinitionCatalogRoot;
  if (release === null || typeof release !== "object"
    || globalDefinitionCatalog?.kind !== "complete"
    || !Array.isArray(release.families)) {
    throw new TypeError("terminal-phase Full-Family release metadata is incomplete");
  }
  const canonicalFamilies = (families: readonly Readonly<{
    readonly familyId: string;
    readonly familyDefinitionHash: Hash;
    readonly sourcePlanRoot: Hash;
    readonly sourcePlanRefs: readonly Parameters<typeof sourcePlanIdentity>[0][];
  }>[]) => families.map(family => ({
    familyId: family.familyId,
    familyDefinitionHash: family.familyDefinitionHash,
    sourcePlanRoot: family.sourcePlanRoot,
    sourcePlanRefs: [...family.sourcePlanRefs].sort((left, right) =>
      sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right))),
  })).sort((left, right) => left.familyId.localeCompare(right.familyId));
  const observedFamilies = canonicalFamilies(release.families);
  const ownerFamilies = canonicalFamilies(terminal.generatedRuntime.families);
  if (release.releaseIntentRoot !== terminal.generatedRuntime.releaseIntentRoot
    || globalDefinitionCatalog.definitionCatalogRoot !== terminal.generatedRuntime.definitionCatalogRoot
    || release.runtimeDescriptorRoot !== terminal.generatedRuntime.runtimeDescriptorRoot
    || encodeCanonicalJson(observedFamilies) !== encodeCanonicalJson(ownerFamilies)) {
    throw new TypeError("terminal-phase Full-Family release metadata does not equal the release-owned generated runtime");
  }
  if (result.candidateReleaseCommit !== terminal.candidateReleaseCommit
    || result.finalDurableWindowId !== terminal.finalDurableWindowId
    || result.producerTerminalBindingRoot !== terminal.producerTerminalBindingRoot
    || result.laneTerminalSetRoot !== terminal.laneTerminalSetRoot
    || result.readyRecordHash !== terminal.readyRecordHash
    || result.auditRoot !== terminal.nativeAuditRoot
    || finalWindow.finalDurableWindowId !== terminal.finalDurableWindowId
    || finalWindow.release.bindingId !== terminal.runtimeBindingId
    || finalWindow.release.releaseProvenanceHash !== terminal.releaseProvenanceHash
    || finalWindow.release.candidateReleaseCommit !== terminal.candidateReleaseCommit
    || finalWindow.serving.generationId !== terminal.generationId
    || finalWindow.serving.readyRecordHash !== terminal.readyRecordHash
    || finalWindow.serving.graphRoot !== terminal.graphRoot) {
    throw new TypeError("terminal-phase Full-Family release/Ready/final-window binding mismatch");
  }
}

function sixStepArtifact(value: ProductionSixStepStoredArtifactV1): ObservedContentArtifactV1 {
  return Object.freeze({
    contentSha256: value.ref.contentSha256,
    bytes: value.bytes,
    ref: value.ref,
    claim: value.claim,
    lease: value.lease,
  });
}

function sixStepProjection(result: ProductionSixStepObserverResultV1) {
  const observed = result.status === "observed" ? result : null;
  const predicateArtifacts = (() => {
    if (observed === null) return Object.freeze([]);
    const byRef = new Map<string, ObservedContentArtifactV1>();
    for (const stage of observed.stageArtifacts) {
      for (const stored of [stage.eventArtifact, stage.semanticArtifactRef, stage.productionReceiptRef, ...stage.inputArtifacts]) {
        const artifact = sixStepArtifact(stored);
        const previous = byRef.get(artifact.ref.artifactRefId);
        if (previous !== undefined && (previous.contentSha256 !== artifact.contentSha256
          || previous.claim.claimId !== artifact.claim.claimId
          || previous.lease.receiptId !== artifact.lease.receiptId)) {
          throw new TypeError("terminal-phase Six-Step artifact identity collision");
        }
        byRef.set(artifact.ref.artifactRefId, artifact);
      }
    }
    return Object.freeze([...byRef.values()].sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId)));
  })();
  const eventArtifactRefIds = Object.freeze(observed?.stageArtifacts.map(stage => stage.eventArtifact.ref.artifactRefId) ?? []);
  const predicateArtifactRoot = hashDomain("aloha/production-six-step-predicate-artifact-closure/v1", predicateArtifacts.map(artifact => ({
    artifactRefId: artifact.ref.artifactRefId,
    contentSha256: artifact.contentSha256,
    claimId: artifact.claim.claimId,
    leaseReceiptId: artifact.lease.receiptId,
  })));
  return Object.freeze({
    status: result.status,
    observationRoot: result.observationRoot,
    finalDurableWindowId: result.finalDurableWindowId,
    windowSelectionRoot: result.windowSelectionRoot,
    selectionPolicyDigest: result.selectionPolicyDigest,
    eligibleSuccessCount: result.eligibleSuccessCount,
    eligibleSuccessRoot: result.eligibleSuccessRoot,
    selectedIndex: result.selectedIndex,
    selectedProducerTerminalId: result.selectedProducerTerminalId,
    reason: result.status === "observed" ? null : result.reason,
    joinedProcessEvidenceRoot: observed?.joinedProcessEvidenceRoot ?? null,
    performanceAppendRecordId: observed?.durableAppendRecordId ?? null,
    producerTerminalAppendRecordId: observed?.producerTerminalDurableAppendRecordId ?? null,
    predicateArtifactCount: String(predicateArtifacts.length),
    predicateArtifactRoot,
    eventArtifactRefIds,
    predicateArtifacts,
    artifactMaterials: Object.freeze(observed?.stageArtifacts ?? []),
  });
}

export function issueProductionTerminalPhaseCollectorPortV1(
  options: Readonly<{
    readonly sink: ContentAddressedObserverSinkV1;
    readonly locatorIndex: ProductionTerminalPhaseLocatorIndexV1;
  }>,
): ProductionTerminalPhaseObservationPortV1 {
  if (options === null || typeof options !== "object" || Reflect.ownKeys(options).length !== 2
    || !(options.sink instanceof ContentAddressedObserverSinkV1)
    || !(options.locatorIndex instanceof ProductionTerminalPhaseLocatorIndexV1)) {
    throw new TypeError("terminal-phase collector port requires collector-owned sink");
  }
  const { sink, locatorIndex } = options;
  return issueProductionTerminalPhaseObservationPortV1(async invocation => {
    const finalWindow = readFinalDurableWindowBindingV1(
      invocation.finalDurableWindowCapability as FinalDurableWindowCapabilityV1,
    );
    const sweep = readRuntimeReleaseFullGraphCoarseSweepManifestV1(
      invocation.fullGraphCoarseSweepCapability as FullGraphCoarseSweepCapabilityV1,
    );
    const terminal = readRuntimeReleaseFullFamilyTerminalBindingV1(
      invocation.runtimeReleaseTerminalBindingCapability as RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
    );
    const fullFamilyResult = readProductionFullFamilyCollectorResultV1(
      invocation.fullFamilyObservationResultCapability as ProductionFullFamilyObservationResultCapabilityV1,
    );
    assertProductionTerminalPhaseReleaseMetadataV1(fullFamilyResult, terminal, finalWindow);
    const fullFamily = createProductionTerminalPhaseFullFamilyProjectionV1(fullFamilyResult);
    const generatedRuntimeMetadata = Object.freeze({
      releaseIntentRoot: terminal.generatedRuntime.releaseIntentRoot,
      definitionCatalogRoot: terminal.generatedRuntime.definitionCatalogRoot,
      descriptorRoot: terminal.generatedRuntime.runtimeDescriptorRoot,
      families: Object.freeze(terminal.generatedRuntime.families.map(family => Object.freeze({
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
        sourcePlanRoot: family.sourcePlanRoot,
        sourcePlanRefs: family.sourcePlanRefs,
      }))),
    });
    const fullFamilyProjectionArtifact = await sink.write({
      bytes: encodeCanonicalBytes(fullFamily),
      mediaType: "application/json",
      schema: FULL_FAMILY_PROJECTION_SCHEMA,
    });
    const fullFamilyTerminalBindingArtifact = fullFamilyResult.observedArtifacts.find(
      value => value.role === "runtime-release-full-family-terminal-binding",
    )?.artifact ?? null;
    const fullGraphCoarseSweepArtifact = fullFamilyResult.observedArtifacts.find(
      value => value.role === "full-graph-coarse-sweep",
    )?.artifact ?? null;
    if (fullFamilyTerminalBindingArtifact === null || fullGraphCoarseSweepArtifact === null) {
      throw new TypeError("terminal-phase Full-Family projection source artifacts are missing");
    }
    const fullFamilyPredicateArtifacts = (() => {
      if (fullFamilyResult.bundle === null || fullFamilyResult.bundleArtifact === null) return Object.freeze([]);
      const expected = new Map(referencedFullFamilyArtifactDigests(fullFamilyResult.bundle));
      const byRef = new Map(fullFamilyResult.observedArtifacts.map(value => [value.artifact.ref.artifactRefId, value.artifact]));
      return Object.freeze([...expected].sort(([left], [right]) => left.localeCompare(right)).map(([artifactRefId, contentSha256]) => {
        const artifact = byRef.get(artifactRefId);
        if (artifact === undefined || artifact.contentSha256 !== contentSha256) {
          throw new TypeError(`terminal-phase Full-Family referenced artifact is missing: ${artifactRefId}`);
        }
        return artifact;
      }));
    })();
    const sixStepResult = readProductionSixStepCollectorResultV1(
      invocation.sixStepObservationResultCapability as ProductionSixStepObservationResultCapabilityV1,
    );
    const sixStep = sixStepProjection(sixStepResult);
    const selectedProcessArtifact = sixStepResult.status === "observed"
      ? sixStepResult.observedArtifacts.find(value => value.role === "joined-process-evidence")?.artifact ?? null
      : null;
    const sixStepTerminalBindingArtifact = sixStepResult.status === "observed"
      ? sixStepResult.observedArtifacts.find(value => value.role === "runtime-release-terminal-binding")?.artifact ?? null
      : null;
    if ((sixStepResult.status === "observed") !== (selectedProcessArtifact !== null)
      || (sixStepResult.status === "observed") !== (sixStepTerminalBindingArtifact !== null)
      || (sixStepResult.status === "observed" && sixStepResult.observedArtifacts.length !== 2)
      || (sixStepResult.status !== "observed" && sixStepResult.observedArtifacts.length !== 0)) {
      throw new TypeError("terminal-phase selected process artifact denominator mismatch");
    }
    if (sweep.sweepRoot !== fullFamily.fullGraphCoarseSweepRoot
      || fullFamily.finalDurableWindowId !== finalWindow.finalDurableWindowId
      || sixStep.finalDurableWindowId !== finalWindow.finalDurableWindowId) {
      throw new TypeError("terminal-phase child observations do not share one final durable window/sweep");
    }
    const runtimeAnchorRoot = hashDomain(
      "aloha/production-terminal-phase-runtime-anchor/v1",
      finalWindow.runtimeAnchor as unknown as CanonicalJson,
    );
    const releaseAnchorRoot = hashDomain(
      "aloha/production-terminal-phase-release-anchor/v1",
      finalWindow.release as unknown as CanonicalJson,
    );
    const processAnchorRoot = hashDomain("aloha/production-terminal-phase-process-anchor/v1", {
      bootId: finalWindow.runtimeAnchor.bootId,
      invocationId: finalWindow.runtimeAnchor.invocationId,
      logDevice: finalWindow.runtimeAnchor.logDevice,
      logInode: finalWindow.runtimeAnchor.logInode,
      pid: finalWindow.runtimeAnchor.pid,
      processStartTicks: finalWindow.runtimeAnchor.processStartTicks,
    });
    const terminalPhaseInvocationRoot = hashDomain("aloha/production-terminal-phase-invocation/v1", {
      finalDurableWindowId: finalWindow.finalDurableWindowId,
      fullGraphCoarseSweepRoot: sweep.sweepRoot,
      fullFamilyObservationRoot: fullFamily.observationRoot,
      sixStepObservationRoot: sixStep.observationRoot,
      releaseAnchorRoot,
      runtimeAnchorRoot,
      runtimeArtifactRoot: finalWindow.runtimeAnchor.runtimeArtifactRoot,
      processAnchorRoot,
    });
    const payload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-manifest-v1" as const,
      finalDurableWindowId: finalWindow.finalDurableWindowId,
      windowId: finalWindow.windowId,
      releaseAnchorRoot,
      runtimeAnchorRoot,
      runtimeArtifactRoot: finalWindow.runtimeAnchor.runtimeArtifactRoot,
      processAnchorRoot,
      fullGraphCoarseSweepRoot: sweep.sweepRoot,
      terminalPhaseInvocationRoot,
      fullFamily: Object.freeze({
        projectionArtifactRefId: fullFamilyProjectionArtifact.ref.artifactRefId,
        projectionContentSha256: fullFamilyProjectionArtifact.contentSha256,
      }),
      sixStep: Object.freeze({
        status: sixStep.status,
        observationRoot: sixStep.observationRoot,
        windowSelectionRoot: sixStep.windowSelectionRoot,
        selectionPolicyDigest: sixStep.selectionPolicyDigest,
        eligibleSuccessCount: sixStep.eligibleSuccessCount,
        eligibleSuccessRoot: sixStep.eligibleSuccessRoot,
        selectedIndex: sixStep.selectedIndex,
        selectedProducerTerminalId: sixStep.selectedProducerTerminalId,
        reason: sixStep.reason,
        joinedProcessEvidenceRoot: sixStep.joinedProcessEvidenceRoot,
        performanceAppendRecordId: sixStep.performanceAppendRecordId,
        producerTerminalAppendRecordId: sixStep.producerTerminalAppendRecordId,
        predicateArtifactCount: sixStep.predicateArtifactCount,
        predicateArtifactRoot: sixStep.predicateArtifactRoot,
        eventArtifactRefIds: sixStep.eventArtifactRefIds,
      }),
    });
    const manifest: ProductionTerminalPhaseManifestV1 = Object.freeze({
      ...payload,
      manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", payload as unknown as CanonicalJson),
    });
    const manifestArtifact = await sink.write({
      bytes: encodeCanonicalBytes(manifest),
      mediaType: "application/json",
      schema: TERMINAL_MANIFEST_SCHEMA,
    });
    const locatorPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-locator-v1" as const,
      finalDurableWindowId: finalWindow.finalDurableWindowId,
      terminalPhaseInvocationRoot,
      manifestRoot: manifest.manifestRoot,
      manifestArtifactRefId: manifestArtifact.ref.artifactRefId,
      manifestContentSha256: manifestArtifact.contentSha256,
    });
    const locator: ProductionTerminalPhaseLocatorV1 = Object.freeze({
      ...locatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", locatorPayload),
    });
    const locatorArtifact = await sink.write({
      bytes: encodeCanonicalBytes(locator),
      mediaType: "application/json",
      schema: TERMINAL_LOCATOR_SCHEMA,
    });
    const locatorIndexRecord = await locatorIndex.publish({
      manifest,
      manifestArtifact,
      locator,
      locatorArtifact,
      selectedProcessArtifact,
      sixStepTerminalBindingArtifact,
      sixStepPredicateArtifacts: sixStep.predicateArtifacts,
      sixStepArtifactMaterials: sixStep.artifactMaterials,
      fullFamilyBundleArtifact: fullFamilyResult.bundleArtifact,
      fullFamilyLocatorArtifact: fullFamilyResult.locatorArtifact,
      fullFamilyProjectionArtifact,
      fullFamilyTerminalBindingArtifact,
      fullGraphCoarseSweepArtifact,
      fullFamilyPredicateArtifacts,
      generatedRuntimeMetadata,
    });
    return Object.freeze({
      manifest,
      manifestArtifact,
      fullFamilyProjectionArtifact,
      locator,
      locatorArtifact,
      selectedProcessArtifact,
      locatorIndexRoot: locatorIndexRecord.indexRoot,
    });
  });
}

export function readProductionTerminalPhaseCollectorResultV1(
  capability: object,
): ProductionTerminalPhaseCollectorResultV1 {
  return readProductionTerminalPhaseObservationResultV1(capability) as ProductionTerminalPhaseCollectorResultV1;
}
