import {
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeArtifactBytes,
  type ArtifactResolutionClaimV1,
  type ResolverPolicyV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  decodeReadOnlyArtifactRef,
  type ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  decodeEvidenceEvent,
  EVIDENCE_SCHEMA_MANIFESTS,
} from "../../../specs/evidence/src/index.ts";
import {
  decodeRawTerminalSelectionObservationV1,
  decodeTerminalSelectionFullFamilyProjectionV1,
  decodeTerminalSelectionFactV1,
  decodeTerminalSelectionManifestV1,
  decodeTerminalSelectionProcessEvidenceV1,
  terminalSelectionProcessAnchorRoot,
  terminalSelectionRuntimeAnchorRoot,
  TERMINAL_SELECTION_ARTIFACT_ROLES,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS,
  TERMINAL_SELECTION_SIX_STEP_PREDICATE_ARTIFACT_ROLE,
  type RawTerminalSelectionObservationV1,
  type TerminalSelectionManifestV1,
  type TerminalSelectionFullFamilyProjectionV1,
  type TerminalSelectionProcessEvidenceV1,
} from "./schema.ts";
import { TERMINAL_SELECTION_INVOCATION_SEAL_ROLE } from "./spec.ts";

export type TerminalSelectionPredicateVerdict = "pass" | "fail" | "invalid";

export type TerminalSelectionReasonCode =
  | "predicate-observation-missing"
  | "predicate-observation-mismatch"
  | "artifact-ref-mismatch"
  | "artifact-claim-mismatch"
  | "observation-mismatch"
  | "process-anchor-mismatch"
  | "predicate-failed";

export interface TerminalSelectionReasonV1 {
  readonly code: TerminalSelectionReasonCode;
  readonly path: string;
}

export interface TerminalSelectionRuntimeFactsV1 {
  readonly facts: readonly unknown[];
  readonly refs: readonly ReadOnlyArtifactRefV1[];
  readonly claims: readonly ArtifactResolutionClaimV1[];
  readonly policies: readonly ResolverPolicyV1[];
  readonly leases: readonly RetentionLeaseReceiptV1[];
  readonly observations: readonly {
    readonly observationId: string;
    readonly rawArtifactRefs: readonly ReadOnlyArtifactRefV1[];
    readonly observedClaimIds: readonly string[];
  }[];
  readonly trustedObserverInvocation?: Readonly<{
    readonly keyId: Hash;
    readonly observerQualificationId: Hash;
    readonly roleId: string;
    readonly authenticatedArtifactRefIds: readonly Hash[];
    readonly candidateReleaseCommit: string;
  }> | null;
}

export interface TerminalSelectionPredicateResultV1 {
  readonly verdict: TerminalSelectionPredicateVerdict;
  readonly reasons: readonly TerminalSelectionReasonV1[];
}

const EXPECTED_POLICY_DIGEST = hashDomain(
  "aloha/searcher-production-six-step-window-selection-policy/v1",
  Object.freeze({
    denominator: "active-exact-100-performance-window",
    eligibility: "complete-successful-dry-run",
    order: Object.freeze(["ordinal", "lane:blockscan-before-backrun", "candidate-stable-key", "producer-terminal-id"]),
    selection: "first",
  }),
);

function same(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function add(reasons: TerminalSelectionReasonV1[], code: TerminalSelectionReasonCode, path: string): void {
  if (!reasons.some(reason => reason.code === code && reason.path === path)) {
    reasons.push(Object.freeze({ code, path }));
  }
}

function field(record: Readonly<Record<string, CanonicalJson>>, key: string): CanonicalJson | undefined {
  return record[key];
}

function hashField(record: Readonly<Record<string, CanonicalJson>>, key: string): Hash | null {
  const value = field(record, key);
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) ? value as Hash : null;
}

function stringField(record: Readonly<Record<string, CanonicalJson>>, key: string): string | null {
  const value = field(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface ObservedArtifactV1<T> {
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claim: ArtifactResolutionClaimV1;
  readonly value: T;
}

const EVIDENCE_EVENT_SCHEMA_REF = Object.freeze({
  id: EVIDENCE_SCHEMA_MANIFESTS.event.id,
  version: EVIDENCE_SCHEMA_MANIFESTS.event.version,
  schemaHash: EVIDENCE_SCHEMA_MANIFESTS.event.schemaHash,
});

function exactOrderedEventArtifactRefs(
  artifacts: readonly ObservedArtifactV1<Uint8Array>[],
): readonly Hash[] | null {
  try {
    const events = artifacts
      .filter(value => same(value.ref.schema, EVIDENCE_EVENT_SCHEMA_REF))
      .map(value => Object.freeze({
        artifactRefId: value.ref.artifactRefId,
        ordinal: decodeEvidenceEvent(value.value).stage.ordinal,
      }))
      .sort((left, right) => left.ordinal - right.ordinal
        || left.artifactRefId.localeCompare(right.artifactRefId));
    if (events.length === 0
      || new Set(events.map(value => value.artifactRefId)).size !== events.length) return null;
    return Object.freeze(events.map(value => value.artifactRefId));
  } catch {
    return null;
  }
}

function observeArtifact<T>(
  artifactRefId: Hash,
  expectedSchema: Readonly<{ readonly id: string; readonly version: string; readonly schemaHash: Hash }> | null,
  runtime: TerminalSelectionRuntimeFactsV1,
  decode: (bytes: Uint8Array) => T,
  reasons: TerminalSelectionReasonV1[],
  path: string,
): ObservedArtifactV1<T> | null {
  const matchingRefs = runtime.refs.filter(value => value.artifactRefId === artifactRefId);
  if (matchingRefs.length !== 1) {
    add(reasons, "artifact-ref-mismatch", `${path}.ref`);
    return null;
  }
  let ref: ReadOnlyArtifactRefV1;
  try {
    ref = decodeReadOnlyArtifactRef(matchingRefs[0]!);
  } catch {
    add(reasons, "artifact-ref-mismatch", `${path}.ref`);
    return null;
  }
  if ((expectedSchema !== null && !same(ref.schema, expectedSchema)) || ref.mediaType !== "application/json") {
    add(reasons, "artifact-ref-mismatch", `${path}.schema`);
  }
  const claims = runtime.claims.filter(value => value.artifactRefId === artifactRefId);
  if (claims.length !== 1) {
    add(reasons, "artifact-claim-mismatch", `${path}.claim`);
    return null;
  }
  const claim = claims[0]!;
  const policy = runtime.policies.find(value => value.policyHash === claim.resolverPolicyHash);
  const lease = runtime.leases.find(value => value.receiptId === ref.retentionLeaseReceiptId);
  if (policy === undefined
    || ref.resolverPolicyHash !== policy.policyHash
    || policy.failureOutcome !== "invalid"
    || claim.outcome !== "content-observed"
    || claim.observedMirror === null
    || lease === undefined
    || lease.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || lease.objectKey !== ref.immutableMirrorLocator.objectKey
    || lease.contentSha256 !== ref.contentSha256) {
    add(reasons, "artifact-claim-mismatch", `${path}.authority`);
    return null;
  }
  const mirror = claim.observedMirror;
  let bytes: Uint8Array;
  try {
    bytes = decodeArtifactBytes(mirror.bytes);
  } catch {
    add(reasons, "predicate-observation-mismatch", `${path}.bytes`);
    return null;
  }
  if (mirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || mirror.objectKey !== ref.immutableMirrorLocator.objectKey
    || mirror.contentSha256 !== ref.contentSha256
    || mirror.byteLength !== ref.byteLength
    || mirror.mediaType !== ref.mediaType
    || !same(mirror.schema, ref.schema)
    || bytes.byteLength.toString() !== ref.byteLength
    || sha256Hex(bytes) !== ref.contentSha256) {
    add(reasons, "artifact-claim-mismatch", `${path}.mirror`);
    return null;
  }
  const observed = runtime.observations.some(observation =>
    observation.rawArtifactRefs.some(value => value.artifactRefId === ref.artifactRefId)
    && observation.observedClaimIds.includes(claim.claimId),
  );
  if (!observed) add(reasons, "observation-mismatch", `${path}.independentObservation`);
  try {
    return Object.freeze({ ref, claim, value: decode(bytes) });
  } catch {
    add(reasons, "predicate-observation-mismatch", `${path}.decoded`);
    return null;
  }
}

function exactObservationDenominator(
  runtime: TerminalSelectionRuntimeFactsV1,
  artifactRefIds: readonly Hash[],
): boolean {
  const expectedRefs = [...artifactRefIds].sort();
  const expectedClaims = artifactRefIds.map(artifactRefId => {
    const claims = runtime.claims.filter(claim => claim.artifactRefId === artifactRefId);
    return claims.length === 1 ? claims[0]!.claimId : null;
  });
  if (expectedClaims.some(value => value === null)) return false;
  const sortedClaims = (expectedClaims as Hash[]).sort();
  return runtime.observations.some(observation =>
    same(observation.rawArtifactRefs.map(ref => ref.artifactRefId).sort(), expectedRefs)
    && same([...observation.observedClaimIds].sort(), sortedClaims));
}

function checkRawStability(
  raw: RawTerminalSelectionObservationV1,
  reasons: TerminalSelectionReasonV1[],
): void {
  if (raw.databaseSha256Before !== raw.databaseSha256After
    || raw.storageSetRootBefore !== raw.storageSetRootAfter) {
    add(reasons, "predicate-observation-mismatch", "$.raw.sqliteSnapshotFence");
  }
  const emptyTerminalPhaseRowRoot = hashDomain("aloha/raw-production-terminal-phase-row-root/v1", []);
  if (raw.terminalPhaseRowCount !== "0" || raw.terminalPhaseRowRoot !== emptyTerminalPhaseRowRoot) {
    add(reasons, "predicate-observation-mismatch", "$.raw.terminalPhaseInvalidRows");
  }
  if (raw.selection.selectionPolicyDigest !== EXPECTED_POLICY_DIGEST) {
    add(reasons, "predicate-observation-mismatch", "$.raw.selection.selectionPolicyDigest");
  }
}

function checkTerminalInvocationRoot(
  manifest: TerminalSelectionManifestV1,
  projection: TerminalSelectionFullFamilyProjectionV1,
  raw: RawTerminalSelectionObservationV1,
  reasons: TerminalSelectionReasonV1[],
): void {
  const releaseAnchorRoot = hashDomain("aloha/production-terminal-phase-release-anchor/v1", raw.release);
  if (manifest.releaseAnchorRoot !== releaseAnchorRoot) {
    add(reasons, "predicate-observation-mismatch", "$.terminalManifest.releaseAnchorRoot");
  }
  if (manifest.terminalPhaseInvocationRoot !== hashDomain("aloha/production-terminal-phase-invocation/v1", {
      finalDurableWindowId: manifest.finalDurableWindowId,
      fullGraphCoarseSweepRoot: manifest.fullGraphCoarseSweepRoot,
      fullFamilyObservationRoot: projection.observationRoot,
      sixStepObservationRoot: manifest.sixStep.observationRoot,
      releaseAnchorRoot: manifest.releaseAnchorRoot,
      runtimeAnchorRoot: manifest.runtimeAnchorRoot,
      runtimeArtifactRoot: manifest.runtimeArtifactRoot,
      processAnchorRoot: manifest.processAnchorRoot,
    })) {
    add(reasons, "predicate-observation-mismatch", "$.terminalManifest.terminalPhaseInvocationRoot");
  }
}

function checkNoSuccessJoin(
  raw: RawTerminalSelectionObservationV1,
  manifest: TerminalSelectionManifestV1,
  projection: TerminalSelectionFullFamilyProjectionV1,
  reasons: TerminalSelectionReasonV1[],
): void {
  if (raw.selection.selectedIndex !== null
    || manifest.sixStep.status !== "missing"
    || raw.selection.finalDurableWindowId !== manifest.finalDurableWindowId
    || raw.selection.selectionRoot !== manifest.sixStep.windowSelectionRoot
    || raw.selection.selectionPolicyDigest !== manifest.sixStep.selectionPolicyDigest
    || raw.selection.eligibleSuccessRoot !== manifest.sixStep.eligibleSuccessRoot) {
    add(reasons, "predicate-observation-mismatch", "$.noSuccessfulDryRunJoin");
  }
  checkTerminalInvocationRoot(manifest, projection, raw, reasons);
}

function checkSelectionJoin(
  raw: RawTerminalSelectionObservationV1,
  manifest: TerminalSelectionManifestV1,
  projection: TerminalSelectionFullFamilyProjectionV1,
  process: TerminalSelectionProcessEvidenceV1,
  reasons: TerminalSelectionReasonV1[],
): void {
  const selection = raw.selection;
  const terminal = manifest.sixStep;
  if (selection.finalDurableWindowId !== manifest.finalDurableWindowId
    || selection.selectionRoot !== terminal.windowSelectionRoot
    || selection.selectionPolicyDigest !== terminal.selectionPolicyDigest
    || selection.eligibleSuccessCount !== terminal.eligibleSuccessCount
    || selection.eligibleSuccessRoot !== terminal.eligibleSuccessRoot
    || selection.selectedIndex !== terminal.selectedIndex
    || selection.selectedProducerTerminalId !== terminal.selectedProducerTerminalId) {
    add(reasons, "predicate-observation-mismatch", "$.rawSelectionToTerminalManifest");
  }
  if (terminal.joinedProcessEvidenceRoot !== process.evidenceRoot
    || terminal.selectedProducerTerminalId !== process.producerTerminalId
    || selection.selectedPerformanceEventId !== process.durableAppend.eventId
    || selection.selectedProducerTerminalEventId !== process.producerTerminalDurableAppend.eventId
    || terminal.performanceAppendRecordId !== process.durableAppendRecordId
    || terminal.producerTerminalAppendRecordId !== process.producerTerminalDurableAppendRecordId) {
    add(reasons, "predicate-observation-mismatch", "$.terminalManifestToSelectedProcess");
  }
  if (process.durableAppend.namespace !== "searcher-production-evidence/performance/v1"
    || process.producerTerminalDurableAppend.namespace !== "searcher-production-evidence/producer-terminals/v1") {
    add(reasons, "predicate-observation-mismatch", "$.selectedProcess.durableAppend");
  }
  if (manifest.processAnchorRoot !== terminalSelectionProcessAnchorRoot(process)
    || manifest.runtimeAnchorRoot !== terminalSelectionRuntimeAnchorRoot(process)
    || manifest.runtimeArtifactRoot !== process.runtimeAnchor.runtimeArtifactRoot) {
    add(reasons, "process-anchor-mismatch", "$.selectedProcess.runtimeAnchor");
  }
  if (process.runtimeBindingId !== process.runtimeAnchor.bindingId
    || process.releaseProvenanceHash !== process.runtimeAnchor.releaseProvenanceHash
    || process.candidateReleaseCommit !== process.runtimeAnchor.candidateReleaseCommit) {
    add(reasons, "process-anchor-mismatch", "$.selectedProcess.release");
  }
  if (hashField(raw.release, "bindingId") !== process.runtimeBindingId
    || hashField(raw.release, "releaseProvenanceHash") !== process.releaseProvenanceHash
    || stringField(raw.release, "candidateReleaseCommit") !== process.candidateReleaseCommit) {
    add(reasons, "process-anchor-mismatch", "$.raw.release");
  }
  if (stringField(raw.serving, "generationId") !== process.generationId
    || hashField(raw.serving, "graphRoot") !== process.graphRoot
    || hashField(raw.serving, "readyRecordHash") !== process.readyRecordHash
    || hashField(raw.serving, "sourceCoverageRoot") !== process.serving.sourceCoverageRoot) {
    add(reasons, "process-anchor-mismatch", "$.raw.serving");
  }
  if (projection.producerTerminalBindingRoot !== process.producerTerminalBindingRoot
    || projection.finalDurableWindowId !== manifest.finalDurableWindowId
    || projection.readyRecordHash !== process.readyRecordHash
    || projection.fullGraphCoarseSweepRoot !== manifest.fullGraphCoarseSweepRoot) {
    add(reasons, "predicate-observation-mismatch", "$.terminalManifest.fullFamily.producerTerminalBindingRoot");
  }
  checkTerminalInvocationRoot(manifest, projection, raw, reasons);
}

export function evaluateTerminalSelectionPredicate(
  runtime: TerminalSelectionRuntimeFactsV1,
): TerminalSelectionPredicateResultV1 {
  const reasons: TerminalSelectionReasonV1[] = [];
  if (runtime.facts.length !== 1) {
    add(reasons, "predicate-observation-missing", "$.facts");
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze(reasons) });
  }
  let fact: ReturnType<typeof decodeTerminalSelectionFactV1>;
  try {
    fact = decodeTerminalSelectionFactV1(runtime.facts[0] as object);
  } catch {
    add(reasons, "predicate-observation-mismatch", "$.facts[0]");
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze(reasons) });
  }
  const hasSelectedProcess = fact.artifacts[3]?.role === TERMINAL_SELECTION_ARTIFACT_ROLES[3];
  const predicateArtifacts = fact.artifacts.slice(hasSelectedProcess ? 4 : 3);
  if (fact.artifacts.length < 3
    || fact.artifacts.slice(0, 3).some((entry, index) => entry.role !== TERMINAL_SELECTION_ARTIFACT_ROLES[index])
    || predicateArtifacts.some(entry => entry.role !== TERMINAL_SELECTION_SIX_STEP_PREDICATE_ARTIFACT_ROLE)
    || predicateArtifacts.some((entry, index) => index > 0 && predicateArtifacts[index - 1]!.artifactRefId >= entry.artifactRefId)
    || new Set(fact.artifacts.map(entry => entry.artifactRefId)).size !== fact.artifacts.length) {
    add(reasons, "predicate-observation-mismatch", "$.facts[0].artifacts");
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze(reasons) });
  }
  const invocation = runtime.trustedObserverInvocation;
  const artifactRefIds = fact.artifacts.map(entry => entry.artifactRefId);
  if (invocation === undefined || invocation === null
    || invocation.roleId !== TERMINAL_SELECTION_INVOCATION_SEAL_ROLE.roleId
    || !same([...invocation.authenticatedArtifactRefIds].sort(), [...artifactRefIds].sort())) {
    add(reasons, "observation-mismatch", "$.trustedObserverInvocation");
  }
  if (!exactObservationDenominator(runtime, artifactRefIds)) {
    add(reasons, "observation-mismatch", "$.rawObserverDenominator");
  }
  const raw = observeArtifact(
    fact.artifacts[0]!.artifactRefId,
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
    runtime,
    decodeRawTerminalSelectionObservationV1,
    reasons,
    "$.raw",
  );
  const manifest = observeArtifact(
    fact.artifacts[1]!.artifactRefId,
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest,
    runtime,
    decodeTerminalSelectionManifestV1,
    reasons,
    "$.terminalManifest",
  );
  const projection = observeArtifact(
    fact.artifacts[2]!.artifactRefId,
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.fullFamilyProjection,
    runtime,
    decodeTerminalSelectionFullFamilyProjectionV1,
    reasons,
    "$.fullFamilyProjection",
  );
  const process = hasSelectedProcess ? observeArtifact(
    fact.artifacts[3]!.artifactRefId,
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.processEvidence,
    runtime,
    decodeTerminalSelectionProcessEvidenceV1,
    reasons,
    "$.selectedProcess",
  ) : null;
  const observedPredicateArtifacts = predicateArtifacts.map((entry, index) => observeArtifact(
    entry.artifactRefId,
    null,
    runtime,
    bytes => bytes,
    reasons,
    `$.sixStepPredicateArtifacts[${index}]`,
  ));
  if (manifest !== null && projection !== null
    && (manifest.value.fullFamily.projectionArtifactRefId !== projection.ref.artifactRefId
      || manifest.value.fullFamily.projectionContentSha256 !== projection.ref.contentSha256)) {
    add(reasons, "predicate-observation-mismatch", "$.terminalManifest.fullFamily");
  }
  if (raw !== null && manifest !== null && projection !== null) {
    checkRawStability(raw.value, reasons);
    if (raw.value.selection.selectedIndex === null && manifest.value.sixStep.status === "missing") {
      checkNoSuccessJoin(raw.value, manifest.value, projection.value, reasons);
      if (hasSelectedProcess || predicateArtifacts.length !== 0) add(reasons, "predicate-observation-mismatch", "$.facts[0].unexpectedProcessArtifact");
      if (invocation !== undefined && invocation !== null
        && stringField(raw.value.release, "candidateReleaseCommit") !== invocation.candidateReleaseCommit) {
        add(reasons, "process-anchor-mismatch", "$.trustedObserverInvocation.candidateReleaseCommit");
      }
      const verdict: TerminalSelectionPredicateVerdict = reasons.length === 0 ? "fail" : "invalid";
      return Object.freeze({ verdict, reasons: Object.freeze(reasons) });
    }
    if (raw.value.selection.selectedIndex === null || manifest.value.sixStep.status !== "observed" || process === null) {
      add(reasons, "predicate-observation-mismatch", "$.selectedTerminalDenominator");
    } else {
      checkSelectionJoin(raw.value, manifest.value, projection.value, process.value, reasons);
      const completePredicateArtifacts = observedPredicateArtifacts.filter((value): value is NonNullable<typeof value> => value !== null);
      const closure = completePredicateArtifacts.map(value => {
        const lease = runtime.leases.find(candidate => candidate.receiptId === value.ref.retentionLeaseReceiptId);
        return lease === undefined ? null : Object.freeze({
          artifactRefId: value.ref.artifactRefId,
          contentSha256: value.ref.contentSha256,
          claimId: value.claim.claimId,
          leaseReceiptId: lease.receiptId,
        });
      });
      const closureRefIds = completePredicateArtifacts.map(value => value.ref.artifactRefId);
      const orderedEventArtifactRefIds = exactOrderedEventArtifactRefs(completePredicateArtifacts);
      if (closure.some(value => value === null)
        || manifest.value.sixStep.predicateArtifactCount !== String(predicateArtifacts.length)
        || manifest.value.sixStep.predicateArtifactRoot !== hashDomain(
          "aloha/production-six-step-predicate-artifact-closure/v1",
          closure as unknown as CanonicalJson,
        )
        || closureRefIds.length !== predicateArtifacts.length
        || orderedEventArtifactRefIds === null
        || !same(manifest.value.sixStep.eventArtifactRefIds, orderedEventArtifactRefIds)) {
        add(reasons, "predicate-observation-mismatch", "$.terminalManifest.sixStep.predicateArtifactClosure");
      }
      if (invocation !== undefined && invocation !== null
        && invocation.candidateReleaseCommit !== process.value.candidateReleaseCommit) {
        add(reasons, "process-anchor-mismatch", "$.trustedObserverInvocation.candidateReleaseCommit");
      }
    }
  }
  const verdict: TerminalSelectionPredicateVerdict = reasons.length === 0 ? "pass" : "invalid";
  return Object.freeze({ verdict, reasons: Object.freeze(reasons) });
}
