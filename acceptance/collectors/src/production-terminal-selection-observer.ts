import {
  assertExactKeys,
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  observeProductionPerformanceDatabaseV1,
} from "../../../packages/performance-collector/src/raw-sqlite-observer.ts";
import {
  createRawTerminalSelectionObservationV1,
  createTerminalSelectionFactV1,
  createTerminalSelectionMissingFactV1,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS,
  type RawTerminalSelectionObservationV1,
  type TerminalSelectionFactV1,
} from "../../terminal-selection-facts/src/schema.ts";
import { ContentAddressedObserverSinkV1, type ObservedContentArtifactV1 } from "./content-addressed-sink.ts";
import {
  assertProductionTerminalPhaseDurableDiscoveryV1,
  ProductionTerminalPhaseLocatorIndexV1,
  type ProductionTerminalPhaseDurableDiscoveryV1,
} from "./terminal-phase-locator-index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../specs/release-authority/src/index.ts";
import {
  readQualifiedReleaseLineageObservationV1,
  type QualifiedReleaseAcceptanceRunnerCapabilityV1,
} from "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts";
import {
  issueProductionTerminalSelectionMaterialCapabilityV1,
  registerProductionTerminalSelectionObserverPortV1,
  type ProductionTerminalSelectionArtifactV1,
  type ProductionTerminalSelectionMaterialV1,
  type ProductionTerminalSelectionObserverPortV1,
} from "./internal/terminal-selection-material-owner.ts";
import { resolveTerminalSelectionServingV1 } from "./internal/terminal-selection-serving.ts";
export {
  assertIssuedProductionTerminalSelectionObserverPortV1,
  readProductionTerminalSelectionMaterialV1,
  type ProductionTerminalSelectionArtifactV1,
  type ProductionTerminalSelectionMaterialCapabilityV1,
  type ProductionTerminalSelectionMaterialV1,
  type ProductionTerminalSelectionObserverPortV1,
} from "./internal/terminal-selection-material-owner.ts";

function artifactProjection(artifact: ObservedContentArtifactV1): ProductionTerminalSelectionArtifactV1 {
  return Object.freeze({
    contentSha256: artifact.contentSha256,
    bytes: Uint8Array.from(artifact.bytes),
    ref: artifact.ref,
    claim: artifact.claim,
    lease: artifact.lease,
  });
}

function releaseCommit(value: Readonly<{ readonly candidateReleaseCommit: unknown }>): string {
  const commit = value.candidateReleaseCommit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new TypeError("terminal-selection raw release commit is invalid");
  }
  return commit;
}

/**
 * Own the only raw SQLite -> durable terminal locator -> predicate material
 * path. The caller cannot supply a locator, process DTO, fact, or verdict.
 */
export function issueProductionTerminalSelectionObserverPortV1(input: Readonly<{
  readonly databasePath: string;
  readonly sink: ContentAddressedObserverSinkV1;
  readonly locatorIndex: ProductionTerminalPhaseLocatorIndexV1;
  readonly qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1;
}>): ProductionTerminalSelectionObserverPortV1 {
  assertExactKeys(input, ["databasePath", "sink", "locatorIndex", "qualifiedReleaseRunner"], "productionTerminalSelectionObserver");
  if (typeof input.databasePath !== "string" || !input.databasePath.startsWith("/")) {
    throw new TypeError("production terminal-selection database path must be absolute");
  }
  if (!(input.sink instanceof ContentAddressedObserverSinkV1)
    || !(input.locatorIndex instanceof ProductionTerminalPhaseLocatorIndexV1)) {
    throw new TypeError("production terminal-selection observer requires collector-owned storage");
  }
  return issueTerminalSelectionObserver(
    input.databasePath,
    input.sink,
    input.qualifiedReleaseRunner,
    finalDurableWindowId => input.locatorIndex.read(finalDurableWindowId),
  );
}

/** Frozen-B variant. It consumes only the branded root-owned discovery and
 * the immutable SQLite snapshot; a raw window id cannot recover authority. */
export function issueProductionFrozenTerminalSelectionObserverPortV1(input: Readonly<{
  readonly databasePath: string;
  readonly sink: ContentAddressedObserverSinkV1;
  readonly durableDiscovery: ProductionTerminalPhaseDurableDiscoveryV1;
  readonly qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1;
}>): ProductionTerminalSelectionObserverPortV1 {
  assertExactKeys(input, ["databasePath", "sink", "durableDiscovery", "qualifiedReleaseRunner"], "productionFrozenTerminalSelectionObserver");
  if (typeof input.databasePath !== "string" || !input.databasePath.startsWith("/")) {
    throw new TypeError("production frozen terminal-selection database path must be absolute");
  }
  if (!(input.sink instanceof ContentAddressedObserverSinkV1)) {
    throw new TypeError("production frozen terminal-selection observer requires collector-owned storage");
  }
  assertProductionTerminalPhaseDurableDiscoveryV1(input.durableDiscovery);
  return issueTerminalSelectionObserver(
    input.databasePath,
    input.sink,
    input.qualifiedReleaseRunner,
    async finalDurableWindowId => {
      if (input.durableDiscovery.manifest.finalDurableWindowId !== finalDurableWindowId) {
        throw new TypeError("frozen terminal-selection SQLite/window mismatch");
      }
      return input.durableDiscovery;
    },
  );
}

function issueTerminalSelectionObserver(
  databasePath: string,
  sink: ContentAddressedObserverSinkV1,
  qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1,
  readDurable: (finalDurableWindowId: Hash) => Promise<ProductionTerminalPhaseDurableDiscoveryV1>,
): ProductionTerminalSelectionObserverPortV1 {
  const lineage = readQualifiedReleaseLineageObservationV1(qualifiedReleaseRunner);
  const port: ProductionTerminalSelectionObserverPortV1 = Object.freeze({
    async observe() {
      const raw = observeProductionPerformanceDatabaseV1(databasePath);
      if (raw.status !== "raw-complete"
        || raw.sixStepWindowSelection === null
        || raw.release === null
        || raw.bundle === null) {
        throw new TypeError(`terminal-selection raw SQLite denominator is invalid: ${raw.reasons.join(",")}`);
      }
      const selection = raw.sixStepWindowSelection;
      const selected = selection.selectedIndex === "0";
      const finalSegment = raw.bundle.generationSegments.at(-1);
      if (finalSegment === undefined) {
        throw new TypeError("terminal-selection raw SQLite denominator lacks final serving segment");
      }
      const serving = resolveTerminalSelectionServingV1({
        events: raw.events,
        selectedIndex: selection.selectedIndex,
        selectedPerformanceEventId: selection.selectedPerformanceEventId,
        finalSegment,
      });
      const emptyTerminalPhaseRoot = hashDomain("aloha/raw-production-terminal-phase-row-root/v1", []);
      if (raw.databaseSha256Before !== raw.databaseSha256After
        || raw.storageSetRootBefore !== raw.storageSetRootAfter
        || raw.terminalPhaseRowCount !== "0"
        || raw.terminalPhaseRowRoot !== emptyTerminalPhaseRoot) {
        throw new TypeError("terminal-selection raw SQLite snapshot contains an unstable or invalid terminal phase");
      }
      const durable = await readDurable(selection.finalDurableWindowId);
      const terminal = durable.manifest.sixStep;
      if (durable.manifest.finalDurableWindowId !== selection.finalDurableWindowId
        || terminal.windowSelectionRoot !== selection.selectionRoot
        || terminal.selectionPolicyDigest !== selection.selectionPolicyDigest
        || terminal.eligibleSuccessCount !== selection.eligibleSuccessCount
        || terminal.eligibleSuccessRoot !== selection.eligibleSuccessRoot
        || terminal.selectedIndex !== selection.selectedIndex
        || terminal.selectedProducerTerminalId !== selection.selectedProducerTerminalId) {
        throw new TypeError("terminal-selection raw SQLite and durable terminal manifest do not join");
      }
      if (selected !== (terminal.status === "observed")
        || selected !== (durable.selectedProcessArtifact !== null)) {
        throw new TypeError("terminal-selection selected process denominator mismatch");
      }
      if (!selected && (selection.eligibleSuccessCount !== "0" || terminal.reason !== "no-successful-dry-run")) {
        throw new TypeError("terminal-selection no-success denominator mismatch");
      }
      const rawObservation = createRawTerminalSelectionObservationV1({
        databaseSha256Before: raw.databaseSha256Before,
        databaseSha256After: raw.databaseSha256After,
        storageSetRootBefore: raw.storageSetRootBefore,
        storageSetRootAfter: raw.storageSetRootAfter,
        sqliteSchemaRoot: raw.sqliteSchemaRoot,
        rawRowRoot: raw.rawRowRoot,
        eventRoot: raw.eventRoot,
        terminalPhaseRowCount: raw.terminalPhaseRowCount,
        terminalPhaseRowRoot: raw.terminalPhaseRowRoot,
        release: Object.freeze({
          bindingId: raw.release.bindingId,
          releaseProvenanceHash: raw.release.releaseProvenanceHash,
          candidateReleaseCommit: raw.release.candidateReleaseCommit,
        }),
        serving,
        selection: selection.selectedIndex === null
          ? Object.freeze({
              finalDurableWindowId: selection.finalDurableWindowId,
              selectionPolicyDigest: selection.selectionPolicyDigest,
              eligibleSuccessCount: "0" as const,
              eligibleSuccessRoot: selection.eligibleSuccessRoot,
              selectedIndex: null,
              selectedProducerTerminalId: null,
              selectedPerformanceEventId: null,
              selectedProducerTerminalEventId: null,
              selectionRoot: selection.selectionRoot,
            })
          : Object.freeze({
              finalDurableWindowId: selection.finalDurableWindowId,
              selectionPolicyDigest: selection.selectionPolicyDigest,
              eligibleSuccessCount: selection.eligibleSuccessCount,
              eligibleSuccessRoot: selection.eligibleSuccessRoot,
              selectedIndex: "0" as const,
              selectedProducerTerminalId: selection.selectedProducerTerminalId!,
              selectedPerformanceEventId: selection.selectedPerformanceEventId!,
              selectedProducerTerminalEventId: selection.selectedProducerTerminalEventId!,
              selectionRoot: selection.selectionRoot,
            }),
      });
      const rawArtifact = await sink.write({
        bytes: encodeCanonicalBytes(rawObservation),
        mediaType: "application/json",
        schema: TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
      });
      const manifestArtifact = durable.manifestArtifact;
      const fullFamilyProjectionArtifact = durable.fullFamilyProjectionArtifact;
      const processArtifact = durable.selectedProcessArtifact;
      const sixStepPredicateArtifacts = [...durable.sixStepPredicateArtifacts]
        .sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId));
      const fact = processArtifact === null
        ? createTerminalSelectionMissingFactV1({
            rawSelectionArtifactRefId: rawArtifact.ref.artifactRefId,
            terminalManifestArtifactRefId: manifestArtifact.ref.artifactRefId,
            fullFamilyProjectionArtifactRefId: fullFamilyProjectionArtifact.ref.artifactRefId,
          })
        : createTerminalSelectionFactV1({
            rawSelectionArtifactRefId: rawArtifact.ref.artifactRefId,
            terminalManifestArtifactRefId: manifestArtifact.ref.artifactRefId,
            fullFamilyProjectionArtifactRefId: fullFamilyProjectionArtifact.ref.artifactRefId,
            processEvidenceArtifactRefId: processArtifact.ref.artifactRefId,
            sixStepPredicateArtifactRefIds: sixStepPredicateArtifacts.map(artifact => artifact.ref.artifactRefId),
          });
      const artifacts = Object.freeze([
        artifactProjection(rawArtifact),
        artifactProjection(manifestArtifact),
        artifactProjection(fullFamilyProjectionArtifact),
        ...(processArtifact === null ? [] : [artifactProjection(processArtifact)]),
        ...sixStepPredicateArtifacts.map(artifactProjection),
      ]);
      if (artifacts.some(artifact => artifact.ref.resolverPolicyHash !== sink.resolverPolicy.policyHash)) {
        throw new TypeError("terminal-selection artifacts do not share the observer resolver policy");
      }
      const material: ProductionTerminalSelectionMaterialV1 = Object.freeze({
        predicateId: "aloha.terminal-selection-lineage.facts" as const,
        finalDurableWindowId: selection.finalDurableWindowId,
        processAnchorHash: durable.manifest.processAnchorRoot,
        candidateReleaseCommit: releaseCommit(raw.release),
        rawObservation,
        fact,
        artifacts,
        resolverPolicy: sink.resolverPolicy,
      });
      return issueProductionTerminalSelectionMaterialCapabilityV1(material);
    },
  });
  registerProductionTerminalSelectionObserverPortV1(port, Object.freeze({
    candidateReleaseCommit: lineage.boundary.candidateReleaseCommit,
    runtimeBindingId: lineage.runtimeBinding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(lineage.runtimeBinding),
  }));
  return port;
}
