import {
  encodeCanonicalBytes,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  readRuntimeReleaseSixStepTerminalBindingV1,
  readRuntimeReleaseSixStepTerminalArtifactsV1,
  type RuntimeReleaseSixStepTerminalBindingCapabilityV1,
  type RuntimeReleaseSixStepTerminalBindingV1,
} from "../../../packages/runtime-release-authority/src/six-step-terminal-consumer.ts";
import {
  readProductionSixStepArtifactMaterialV1,
  type ProductionSixStepArtifactMaterialV1,
} from "../../../packages/evidence-emitter/src/index.ts";
import {
  readSearcherProductionSixStepProcessEvidenceV1,
  readSearcherProductionSixStepWindowSelectionV1,
  type SearcherProductionSixStepProcessCapabilityV1,
  type SearcherProductionSixStepProcessEvidenceV1,
  type SearcherProductionSixStepWindowSelectionCapabilityV1,
  type SearcherProductionSixStepWindowSelectionV1,
} from "../../../packages/six-step-process-evidence/src/index.ts";
import type { SchemaRef } from "../../../specs/core-envelope/src/index.ts";
import {
  ContentAddressedObserverSinkV1,
  type ObservedContentArtifactV1,
} from "./content-addressed-sink.ts";
import { productionSixStepObservedRootV1 } from "./internal/six-step-observation-root.ts";

export type SixStepObserverMissingReasonV1 =
  | "no-successful-dry-run"
  | "terminal-binding-missing"
  | "joined-process-evidence-missing";

export type SixStepObserverInvalidReasonV1 =
  | "window-selection-capability-invalid"
  | "terminal-capability-invalid"
  | "terminal-artifact-capability-invalid"
  | "process-capability-invalid"
  | "terminal-process-binding-mismatch";

export interface SixStepObservedRawArtifactV1 {
  readonly role: "runtime-release-terminal-binding" | "joined-process-evidence";
  readonly artifact: ObservedContentArtifactV1;
}

export type ProductionSixStepObserverResultV1 =
  | Readonly<{
      readonly kind: "aloha.production-six-step-observation-missing-v1";
      readonly status: "missing";
      readonly reason: SixStepObserverMissingReasonV1;
      readonly finalDurableWindowId: Hash | null;
      readonly windowSelectionRoot: Hash | null;
      readonly selectionPolicyDigest: Hash | null;
      readonly eligibleSuccessCount: string | null;
      readonly eligibleSuccessRoot: Hash | null;
      readonly selectedIndex: "0" | null;
      readonly selectedProducerTerminalId: Hash | null;
      readonly observedArtifacts: readonly SixStepObservedRawArtifactV1[];
      readonly observationRoot: Hash;
    }>
  | Readonly<{
      readonly kind: "aloha.production-six-step-observation-invalid-v1";
      readonly status: "invalid";
      readonly reason: SixStepObserverInvalidReasonV1;
      readonly finalDurableWindowId: Hash | null;
      readonly windowSelectionRoot: Hash | null;
      readonly selectionPolicyDigest: Hash | null;
      readonly eligibleSuccessCount: string | null;
      readonly eligibleSuccessRoot: Hash | null;
      readonly selectedIndex: "0" | null;
      readonly selectedProducerTerminalId: Hash | null;
      readonly observedArtifacts: readonly SixStepObservedRawArtifactV1[];
      readonly observationRoot: Hash;
    }>
  | Readonly<{
      readonly kind: "aloha.production-six-step-observation-v1";
      /** Observed means raw facts were captured and top-level owner lineage
       * joined. It is not an acceptance verdict. */
      readonly status: "observed";
      readonly runtimeBindingId: Hash;
      readonly candidateReleaseCommit: string;
      readonly releaseProvenanceHash: Hash;
      readonly finalDurableWindowId: Hash;
      readonly windowSelectionRoot: Hash;
      readonly selectionPolicyDigest: Hash;
      readonly eligibleSuccessCount: string;
      readonly eligibleSuccessRoot: Hash;
      readonly selectedIndex: "0";
      readonly selectedProducerTerminalId: Hash;
      readonly terminalBindingRoot: Hash;
      readonly joinedProcessEvidenceRoot: Hash;
      readonly durableAppendRecordId: Hash;
      readonly producerTerminalDurableAppendRecordId: Hash;
      readonly traceRoot: Hash;
      readonly stage12Root: Hash;
      readonly sixStepLineageRoot: Hash;
      readonly runtimeAnchorRoot: Hash;
      readonly runtimeFactsRoot: Hash;
      readonly programHash: Hash;
      readonly finalSimulationReceiptHash: Hash;
      /** Complete producer-owned Stage 1-6 closure in predicate order.  The
       * collector preserves every original locator/ref/claim/lease and never
       * creates replacement stage evidence. */
      readonly stageArtifacts: readonly ProductionSixStepArtifactMaterialV1[];
      readonly observedArtifacts: readonly SixStepObservedRawArtifactV1[];
      readonly observationRoot: Hash;
    }>;

export interface ProductionSixStepObserverInputV1 {
  readonly windowSelectionCapability: SearcherProductionSixStepWindowSelectionCapabilityV1;
  readonly terminalBindingCapability: RuntimeReleaseSixStepTerminalBindingCapabilityV1 | null;
  readonly joinedProcessCapability: SearcherProductionSixStepProcessCapabilityV1 | null;
  readonly sink: ContentAddressedObserverSinkV1;
}

function localSchema(id: string, descriptor: unknown): SchemaRef {
  const version = "1.0.0";
  return Object.freeze({
    id,
    version,
    schemaHash: hashDomain("aloha/schema-definition/v1", { id, version, descriptor }),
  });
}

const TERMINAL_BINDING_SCHEMA = localSchema("aloha.observer.six-step-terminal-binding", {
  owner: "runtime-release-authority",
  exactKind: "aloha.runtime-release-six-step-terminal-binding-v1",
});

const PROCESS_EVIDENCE_SCHEMA = localSchema("aloha.observer.six-step-process-evidence", {
  owner: "six-step-process-evidence",
  exactKind: "aloha.searcher-production-six-step-process-evidence-v1",
});

function sameSource(
  left: Readonly<{ chainId: string; number: string; hash: string; stateRoot: string }>,
  right: Readonly<{ chainId: string; number: string; hash: string; stateRoot: string }>,
): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

/**
 * Join only identities that are already authenticated by independent owner
 * capabilities. This function deliberately does not run the production
 * execution-program sealer, action decoders, effect normalization, or
 * obligation logic. Those load-bearing semantics belong to the qualified
 * predicate and its independent decoder/mutation corpus.
 */
function exactTerminalProcessJoin(
  terminal: RuntimeReleaseSixStepTerminalBindingV1,
  process: SearcherProductionSixStepProcessEvidenceV1,
): void {
  if (process.runtimeBindingId !== terminal.runtimeBindingId
    || process.candidateReleaseCommit !== terminal.candidateReleaseCommit
    || process.releaseProvenanceHash !== terminal.releaseProvenanceHash
    || process.terminalBindingRoot !== terminal.bindingRoot
    || process.traceRoot !== terminal.traceRoot
    || process.correlationId !== terminal.correlationId
    || process.generationId !== terminal.generationId
    || process.readyRecordHash !== terminal.readyRecordHash
    || process.graphRoot !== terminal.graphRoot
    || !sameSource(process.currentSource, terminal.currentSource)
    || process.programHash !== terminal.programHash
    || process.finalSimulationReceiptHash !== terminal.finalSimulationReceiptHash
    || process.durableAppend.fsynced !== true
    || process.producerTerminalDurableAppend.fsynced !== true) {
    throw new TypeError("Six-Step terminal/process owner lineage mismatch");
  }
}

function sealNonObservedResult<Payload extends Readonly<{
  readonly kind: "aloha.production-six-step-observation-missing-v1" | "aloha.production-six-step-observation-invalid-v1";
  readonly status: "missing" | "invalid";
  readonly reason: string;
  readonly observedArtifacts: readonly SixStepObservedRawArtifactV1[];
}>>(payload: Payload): Payload & Readonly<{ readonly observationRoot: Hash }> {
  return Object.freeze({
    ...payload,
    observationRoot: hashDomain(
      "aloha/production-six-step-observation/v1",
      payload as unknown as CanonicalJson,
    ),
  });
}

function selectionProjection(selection: SearcherProductionSixStepWindowSelectionV1) {
  return Object.freeze({
    finalDurableWindowId: selection.finalDurableWindowId,
    windowSelectionRoot: selection.selectionRoot,
    selectionPolicyDigest: selection.selectionPolicyDigest,
    eligibleSuccessCount: selection.eligibleSuccessCount,
    eligibleSuccessRoot: selection.eligibleSuccessRoot,
    selectedIndex: selection.selectedIndex,
    selectedProducerTerminalId: selection.selectedProducerTerminalId,
  });
}

export async function observeProductionSixStep(
  input: ProductionSixStepObserverInputV1,
): Promise<ProductionSixStepObserverResultV1> {
  if (!(input.sink instanceof ContentAddressedObserverSinkV1)) {
    throw new TypeError("production Six-Step observer requires collector-owned sink");
  }
  let selection: SearcherProductionSixStepWindowSelectionV1;
  try {
    selection = readSearcherProductionSixStepWindowSelectionV1(input.windowSelectionCapability);
  } catch {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-invalid-v1",
      status: "invalid",
      reason: "window-selection-capability-invalid",
      finalDurableWindowId: null,
      windowSelectionRoot: null,
      selectionPolicyDigest: null,
      eligibleSuccessCount: null,
      eligibleSuccessRoot: null,
      selectedIndex: null,
      selectedProducerTerminalId: null,
      observedArtifacts: Object.freeze([]),
    }));
  }
  if (selection.status === "missing") {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-missing-v1",
      status: "missing",
      reason: selection.reason,
      ...selectionProjection(selection),
      observedArtifacts: Object.freeze([]),
    }));
  }
  if (input.terminalBindingCapability === null) {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-missing-v1",
      status: "missing",
      reason: "terminal-binding-missing",
      ...selectionProjection(selection),
      observedArtifacts: Object.freeze([]),
    }));
  }
  if (input.joinedProcessCapability === null) {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-missing-v1",
      status: "missing",
      reason: "joined-process-evidence-missing",
      ...selectionProjection(selection),
      observedArtifacts: Object.freeze([]),
    }));
  }
  let terminal: RuntimeReleaseSixStepTerminalBindingV1;
  try {
    terminal = readRuntimeReleaseSixStepTerminalBindingV1(input.terminalBindingCapability);
  } catch {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-invalid-v1",
      status: "invalid",
      reason: "terminal-capability-invalid",
      ...selectionProjection(selection),
      observedArtifacts: Object.freeze([]),
    }));
  }
  let process: SearcherProductionSixStepProcessEvidenceV1;
  try {
    process = readSearcherProductionSixStepProcessEvidenceV1(input.joinedProcessCapability);
  } catch {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-invalid-v1",
      status: "invalid",
      reason: "process-capability-invalid",
      ...selectionProjection(selection),
      observedArtifacts: Object.freeze([]),
    }));
  }
  try {
    exactTerminalProcessJoin(terminal, process);
    if (process.producerTerminalId !== selection.selectedProducerTerminalId) {
      throw new TypeError("Six-Step window selection/process terminal mismatch");
    }
  } catch {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-invalid-v1",
      status: "invalid",
      reason: "terminal-process-binding-mismatch",
      ...selectionProjection(selection),
      observedArtifacts: Object.freeze([]),
    }));
  }
  let stageArtifacts: readonly ProductionSixStepArtifactMaterialV1[];
  try {
    const artifacts = readRuntimeReleaseSixStepTerminalArtifactsV1(input.terminalBindingCapability);
    const stage1 = artifacts.stage1.map(readProductionSixStepArtifactMaterialV1)
      .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId));
    const stage2 = artifacts.stage2.map(readProductionSixStepArtifactMaterialV1)
      .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId));
    stageArtifacts = Object.freeze([
      ...stage1,
      ...stage2,
      readProductionSixStepArtifactMaterialV1(artifacts.stage3),
      readProductionSixStepArtifactMaterialV1(artifacts.stage4),
      readProductionSixStepArtifactMaterialV1(artifacts.stage5),
      readProductionSixStepArtifactMaterialV1(artifacts.stage6),
    ]);
  } catch {
    return sealNonObservedResult(Object.freeze({
      kind: "aloha.production-six-step-observation-invalid-v1",
      status: "invalid",
      reason: "terminal-artifact-capability-invalid",
      ...selectionProjection(selection),
      observedArtifacts: Object.freeze([]),
    }));
  }
  const terminalArtifact = await input.sink.write({
    bytes: encodeCanonicalBytes(terminal),
    mediaType: "application/json",
    schema: TERMINAL_BINDING_SCHEMA,
  });
  const processArtifact = await input.sink.write({
    bytes: encodeCanonicalBytes(process),
    mediaType: "application/json",
    schema: PROCESS_EVIDENCE_SCHEMA,
  });
  const observedArtifacts = Object.freeze([
    Object.freeze({ role: "runtime-release-terminal-binding" as const, artifact: terminalArtifact }),
    Object.freeze({ role: "joined-process-evidence" as const, artifact: processArtifact }),
  ]);
  const payload = Object.freeze({
    kind: "aloha.production-six-step-observation-v1" as const,
    status: "observed" as const,
    runtimeBindingId: terminal.runtimeBindingId,
    candidateReleaseCommit: terminal.candidateReleaseCommit,
    releaseProvenanceHash: terminal.releaseProvenanceHash,
    finalDurableWindowId: selection.finalDurableWindowId,
    windowSelectionRoot: selection.selectionRoot,
    selectionPolicyDigest: selection.selectionPolicyDigest,
    eligibleSuccessCount: selection.eligibleSuccessCount,
    eligibleSuccessRoot: selection.eligibleSuccessRoot,
    selectedIndex: selection.selectedIndex,
    selectedProducerTerminalId: selection.selectedProducerTerminalId,
    terminalBindingRoot: terminal.bindingRoot,
    joinedProcessEvidenceRoot: process.evidenceRoot,
    durableAppendRecordId: process.durableAppendRecordId,
    producerTerminalDurableAppendRecordId: process.producerTerminalDurableAppendRecordId,
    traceRoot: terminal.traceRoot,
    stage12Root: process.stage12Root,
    sixStepLineageRoot: process.sixStepLineageRoot,
    runtimeAnchorRoot: process.runtimeAnchorRoot,
    runtimeFactsRoot: process.runtimeFactsRoot,
    programHash: terminal.programHash,
    finalSimulationReceiptHash: terminal.finalSimulationReceiptHash,
    stageArtifacts,
    observedArtifacts,
  });
  return Object.freeze({
    ...payload,
    observationRoot: productionSixStepObservedRootV1(payload),
  });
}
