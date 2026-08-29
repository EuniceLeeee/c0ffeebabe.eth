import { issueRootPredicateMaterialSourceV1 } from "./internal/root-predicate-material-source-owner.ts";
import { issueProductionClosureMaterialObserverPortsV1 } from "../../../acceptance/collectors/src/production-runtime-boundary-observers.ts";
import { decodeCanonicalBytes, encodeCanonicalBytes, hashDomain, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { hashProcessAnchor } from "../../../specs/core-envelope/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../specs/release-authority/src/index.ts";
import {
  observeQualifiedReleaseAcceptanceAdvisoryV1,
  prepareQualifiedReleaseAcceptanceForExternalOwnerV1,
  readQualifiedReleaseLineageObservationV1,
} from "./internal/qualified-release-public-runner-state.ts";
import {
  readPreReleaseAdvisoryMaterialCapabilityV1,
  type PreReleaseAdvisoryMaterialCapabilityV1,
} from "./pre-release-staging.ts";
import type {
  PreReleaseAdvisoryMaterialProjectionV1,
  PreReleaseStagingArtifactIdentityV1,
  PreReleaseStagingArtifactNameV1,
} from "./pre-release-staging-contract.ts";
import {
  PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1,
  PRE_RELEASE_STAGING_LAYOUT_V1,
  preReleaseStagingArtifactPathV1,
} from "./internal/pre-release-staging-schema.ts";
import {
  readPreReleaseAdvisoryMaterialV1,
  type PreReleaseAdvisoryMaterialV1,
} from "./internal/pre-release-runtime-receipt-state.ts";
import { assertProductionTerminalPhaseDurableDiscoveryV1 } from "../../../acceptance/collectors/src/terminal-phase-locator-index.ts";
import type { ProductionTerminalPhaseDurableDiscoveryV1 } from "../../../acceptance/collectors/src/terminal-phase-locator-index.ts";
import {
  decodeFullGraphCoarseSweepManifestV1,
  type FullGraphCoarseSweepV1,
} from "../../../packages/full-graph-coarse-sweep/src/index.ts";
import type { AssembledPredicateEvaluationV1 } from "../../../acceptance/gate-core/src/material-provider.ts";
import type { PreReleaseControllerDatabaseSnapshotPublicationV1 } from "../../pre-release-restart-controller/src/durable-owner.ts";
import { readProductionPerformanceMaterialObserverReleaseBindingV1 } from "../../../acceptance/collectors/src/internal/performance-material-observer-owner.ts";
import { readProductionTerminalSelectionObserverReleaseBindingV1 } from "../../../acceptance/collectors/src/internal/terminal-selection-material-owner.ts";
import { readProductionRuntimeRestartMaterialObserverReleaseBindingV1 } from "../../../acceptance/collectors/src/internal/runtime-boundary-material-owner.ts";
import { readReleaseOwnedObserverStoreV1 } from "../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import {
  createNominationQualificationReuseConsumerV1,
  type NominationQualificationPostSignReportV1,
  type NominationQualificationPreSignReportV1,
} from "./nomination-qualification-reuse.ts";
import {
  observeProductionNominationQualificationReuseCompositionV1,
  readProductionNominationQualificationReusePostSignInputV1,
} from "./nomination-qualification-reuse-owner.ts";
import type { AcceptanceCertificateV1 } from "../../../specs/acceptance-certificate/src/index.ts";
import type {
  ReleaseAcceptanceSetV1,
  SignedReleaseAcceptanceApprovalSigningInputV1,
} from "../../../specs/qualification/src/index.ts";

export type ProductionReleaseAcceptanceAdvisoryStatusV1 = "pass" | "fail" | "invalid" | "incomplete";

export interface ProductionReleaseAcceptanceAdvisoryReasonV1 {
  readonly predicateId: string;
  readonly code: string;
}

export interface ProductionReleaseAcceptanceSigningRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.release-acceptance-signing-request";
  readonly acceptanceCertificates: readonly AcceptanceCertificateV1[];
  readonly releaseAcceptanceSet: ReleaseAcceptanceSetV1;
  readonly signingInput: SignedReleaseAcceptanceApprovalSigningInputV1;
  readonly signingBytesHex: string;
  readonly requestRoot: Hash;
}

export type ProductionReleaseAcceptancePreparationCapabilityV1 = object;

interface ProductionReleaseAcceptancePreparationStateV1 {
  readonly preparedAcceptance: Awaited<ReturnType<typeof prepareQualifiedReleaseAcceptanceForExternalOwnerV1>>["preparedAcceptance"];
  readonly signingRequest: ProductionReleaseAcceptanceSigningRequestV1;
}

const productionReleaseAcceptancePreparations = new WeakMap<
  object,
  ProductionReleaseAcceptancePreparationStateV1
>();

export interface ProductionReleaseAcceptanceAdvisoryFactIndexV1 {
  readonly terminalPhase: Readonly<{
    readonly finalDurableWindowId: Hash;
    readonly terminalLocatorDirectory: string;
    readonly observerContentStore: Readonly<{
      readonly directory: string;
      readonly device: string;
      readonly inode: string;
      readonly storeIdentityHash: Hash;
    }>;
    readonly index: Readonly<{
      readonly path: string;
      readonly device: string;
      readonly inode: string;
      readonly contentSha256: Hash;
      readonly byteLength: string;
      readonly indexRoot: Hash;
    }>;
    readonly locator: Readonly<{
      readonly locatorRoot: Hash;
      readonly artifactRefId: Hash;
      readonly contentSha256: Hash;
    }>;
    readonly manifest: Readonly<{
      readonly manifestRoot: Hash;
      readonly artifactRefId: Hash;
      readonly contentSha256: Hash;
    }>;
    readonly fullFamilyTerminalBinding: Readonly<{
      readonly artifactRefId: Hash;
      readonly contentSha256: Hash;
    }>;
    readonly fullGraphCoarseSweep: Readonly<{
      readonly artifactRefId: Hash;
      readonly contentSha256: Hash;
      readonly sweepRoot: Hash;
      readonly expectedTransitionCount: string;
      readonly expectedTransitionRoot: Hash;
      readonly observedTransitionCount: string;
      readonly observedTransitionRoot: Hash;
      readonly missingTransitionCount: string;
      readonly missingTransitionRoot: Hash;
      readonly familyTransitionCounts: FullGraphCoarseSweepV1["familyTransitionCounts"];
    }>;
    readonly sixStepPhysicalStatus: "observed" | "invalid";
    readonly sixStepPhysicalReason: string | null;
  }>;
  readonly processEvidenceQuery: Readonly<{
    readonly databasePath: string;
    readonly routeDenominator: Readonly<{
      readonly namespace: "searcher-production-evidence/route-denominators/v1";
      readonly eventType: "route-denominator";
      readonly accountingEntriesPath: "payload.accounting.entries";
    }>;
    readonly candidateSet: Readonly<{
      readonly namespace: "searcher-production-evidence/candidate-sets/v1";
      readonly eventType: "candidate-set";
      readonly laneDenominatorsPath: "payload.laneDenominators";
      readonly terminalObservationsPath: "payload.candidateTerminalObservations";
    }>;
    readonly joins: Readonly<{
      readonly head: readonly Readonly<{ readonly routePath: string; readonly candidateSetPath: string }>[];
      readonly lane: readonly Readonly<{ readonly routePath: string; readonly candidateLanePath: string }>[];
      readonly candidate: Readonly<{
        readonly routeEntriesPath: "payload.accounting.entries";
        readonly terminalObservationsPath: "payload.candidateTerminalObservations";
        readonly routeLanePath: "payload.lane";
        readonly terminalLanePath: "lane";
        readonly identity: Readonly<{ readonly routePath: "candidateId"; readonly terminalPath: "candidateId" }>;
        readonly matching: "filter-terminal-by-route-lane-then-exact-order-and-cardinality";
        readonly equalFields: readonly [
          "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal",
        ];
      }>;
    }>;
    readonly exactAdmission: Readonly<{
      readonly sourcePath: "payload.accounting.entries[].disposition";
      readonly disposition: "selected";
    }>;
  }>;
}

export type ProductionNominationQualificationReuseObservationV1 =
  | Readonly<{
    readonly status: "unavailable";
    readonly code: "verified-release-authority-composition-unavailable";
    readonly advisoryOnly: true;
  }>
  | Readonly<{
    readonly status: "available";
    readonly advisoryOnly: true;
    readonly preSignReport: NominationQualificationPreSignReportV1;
    readonly postSignReport: NominationQualificationPostSignReportV1;
  }>;

export interface ProductionReleaseAcceptanceAdvisoryReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-acceptance-advisory-judgment";
  readonly status: ProductionReleaseAcceptanceAdvisoryStatusV1;
  readonly reasons: readonly ProductionReleaseAcceptanceAdvisoryReasonV1[];
  readonly release: Readonly<{
    readonly candidateReleaseCommit: string;
    readonly runtimeBindingId: Hash;
    readonly releaseProvenanceHash: Hash;
  }>;
  readonly physicalProcess: Readonly<{
    readonly processAnchorHash: Hash;
    readonly pid: string;
    readonly processStartTicks: string;
    readonly bootIdHash: Hash;
    readonly executableHash: Hash;
    readonly dryRun: true;
  }>;
  readonly authority: Readonly<{
    readonly advisoryOnly: true;
    readonly candidateGeneratedAuthority: null;
    readonly runtimeReleaseBinding: null;
    readonly releaseAuthority: null;
    readonly submissionAuthority: null;
    readonly sign: false;
    readonly broadcast: false;
    readonly promote: false;
  }>;
  readonly factBinding: Readonly<{
    readonly processImportReceiptId: Hash;
    readonly databaseContentSha256: Hash;
    readonly terminalSnapshotTrustRoot: Hash | null;
  }>;
  readonly factLocators: Readonly<{
    readonly processEvidenceDatabasePath: string;
    readonly checkpointDatabasePath: string;
    readonly frozenCheckpointSnapshotPublication: PreReleaseControllerDatabaseSnapshotPublicationV1;
    readonly observerStoreDirectory: string;
    readonly authorizationLedgerPath: string;
    readonly processEvidenceDatabase: Readonly<{
      readonly path: string;
      readonly device: string;
      readonly inode: string;
      readonly contentSha256: Hash;
    }>;
    readonly logWindow: Readonly<{
      readonly path: string;
      readonly device: string;
      readonly inode: string;
      readonly startInclusive: string;
      readonly endExclusive: string;
      readonly contentSha256: Hash;
    }>;
  }>;
  readonly artifactLocators: readonly PreReleaseStagingArtifactIdentityV1[];
  readonly factIndex: ProductionReleaseAcceptanceAdvisoryFactIndexV1;
  readonly evaluations: readonly AssembledPredicateEvaluationV1[];
  readonly nominationQualificationReuse: ProductionNominationQualificationReuseObservationV1;
  readonly judgedAtUnixNs: string;
  readonly judgmentRoot: Hash;
}

type AdvisoryStagingArtifactBytesV1 = Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>;

export function buildProductionReleaseAcceptanceAdvisoryFactIndexV1(
  processEvidenceDatabasePath: string,
  discovery: ProductionTerminalPhaseDurableDiscoveryV1,
): ProductionReleaseAcceptanceAdvisoryFactIndexV1 {
  const expectedIndexPath = `${discovery.indexDirectory}/${discovery.index.finalDurableWindowId.slice(2)}.json`;
  if (discovery.indexPath !== expectedIndexPath) throw new TypeError("pre-release advisory terminal index path mismatch");
  const sweep = decodeFullGraphCoarseSweepManifestV1(discovery.fullGraphCoarseSweepArtifact.bytes);
  return Object.freeze({
    terminalPhase: Object.freeze({
      finalDurableWindowId: discovery.index.finalDurableWindowId,
      terminalLocatorDirectory: discovery.indexDirectory,
      observerContentStore: Object.freeze({
        directory: discovery.observerContentDirectory,
        device: discovery.observerContentDirectoryDevice,
        inode: discovery.observerContentDirectoryInode,
        storeIdentityHash: discovery.observerStoreIdentityHash,
      }),
      index: Object.freeze({
        path: discovery.indexPath,
        device: discovery.indexDevice,
        inode: discovery.indexInode,
        contentSha256: discovery.indexContentSha256,
        byteLength: discovery.indexByteLength,
        indexRoot: discovery.index.indexRoot,
      }),
      locator: Object.freeze({
        locatorRoot: discovery.locator.locatorRoot,
        artifactRefId: discovery.locatorArtifact.ref.artifactRefId,
        contentSha256: discovery.locatorArtifact.contentSha256,
      }),
      manifest: Object.freeze({
        manifestRoot: discovery.manifest.manifestRoot,
        artifactRefId: discovery.manifestArtifact.ref.artifactRefId,
        contentSha256: discovery.manifestArtifact.contentSha256,
      }),
      fullFamilyTerminalBinding: Object.freeze({
        artifactRefId: discovery.fullFamilyTerminalBindingArtifact.ref.artifactRefId,
        contentSha256: discovery.fullFamilyTerminalBindingArtifact.contentSha256,
      }),
      fullGraphCoarseSweep: Object.freeze({
        artifactRefId: discovery.fullGraphCoarseSweepArtifact.ref.artifactRefId,
        contentSha256: discovery.fullGraphCoarseSweepArtifact.contentSha256,
        sweepRoot: sweep.sweepRoot,
        expectedTransitionCount: sweep.expectedTransitionCount,
        expectedTransitionRoot: sweep.expectedTransitionRoot,
        observedTransitionCount: sweep.observedTransitionCount,
        observedTransitionRoot: sweep.observedTransitionRoot,
        missingTransitionCount: sweep.missingTransitionCount,
        missingTransitionRoot: sweep.missingTransitionRoot,
        familyTransitionCounts: Object.freeze(sweep.familyTransitionCounts.map(value => Object.freeze({ ...value }))),
      }),
      sixStepPhysicalStatus: discovery.sixStepPhysicalStatus,
      sixStepPhysicalReason: discovery.sixStepPhysicalReason,
    }),
    processEvidenceQuery: Object.freeze({
      databasePath: processEvidenceDatabasePath,
      routeDenominator: Object.freeze({
        namespace: "searcher-production-evidence/route-denominators/v1" as const,
        eventType: "route-denominator" as const,
        accountingEntriesPath: "payload.accounting.entries" as const,
      }),
      candidateSet: Object.freeze({
        namespace: "searcher-production-evidence/candidate-sets/v1" as const,
        eventType: "candidate-set" as const,
        laneDenominatorsPath: "payload.laneDenominators" as const,
        terminalObservationsPath: "payload.candidateTerminalObservations" as const,
      }),
      joins: Object.freeze({
        head: Object.freeze([
          Object.freeze({ routePath: "payload.admissionId", candidateSetPath: "payload.admissionId" }),
          Object.freeze({ routePath: "payload.headFactsRoot", candidateSetPath: "payload.headFactsRoot" }),
          Object.freeze({ routePath: "payload.headHash", candidateSetPath: "payload.headHash" }),
        ]),
        lane: Object.freeze([
          Object.freeze({ routePath: "payload.lane", candidateLanePath: "lane" }),
          Object.freeze({ routePath: "payload.correlationId", candidateLanePath: "correlationId" }),
          Object.freeze({ routePath: "payload.coverageRoot", candidateLanePath: "coverageRoot" }),
          Object.freeze({ routePath: "payload.accounting.root", candidateLanePath: "accountingRoot" }),
        ]),
        candidate: Object.freeze({
          routeEntriesPath: "payload.accounting.entries" as const,
          terminalObservationsPath: "payload.candidateTerminalObservations" as const,
          routeLanePath: "payload.lane" as const,
          terminalLanePath: "lane" as const,
          identity: Object.freeze({ routePath: "candidateId" as const, terminalPath: "candidateId" as const }),
          matching: "filter-terminal-by-route-lane-then-exact-order-and-cardinality" as const,
          equalFields: Object.freeze([
            "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal",
          ] as const),
        }),
      }),
      exactAdmission: Object.freeze({
        sourcePath: "payload.accounting.entries[].disposition" as const,
        disposition: "selected" as const,
      }),
    }),
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function readAdvisoryStagingArtifactBytes(
  projection: PreReleaseAdvisoryMaterialProjectionV1,
  material: PreReleaseAdvisoryMaterialV1,
): AdvisoryStagingArtifactBytesV1 {
  const names = Reflect.ownKeys(material.stagingArtifactBytes);
  if (names.length !== PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.length
    || names.some(name => typeof name !== "string"
      || !PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.includes(name as PreReleaseStagingArtifactNameV1))) {
    throw new TypeError("pre-release advisory staging artifact byte denominator mismatch");
  }
  const copies = {} as Record<PreReleaseStagingArtifactNameV1, Uint8Array>;
  for (const [index, name] of PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.entries()) {
    const identity = projection.stagingArtifacts[index];
    const value = material.stagingArtifactBytes[name];
    if (identity === undefined || identity.name !== name
      || identity.installPath !== preReleaseStagingArtifactPathV1(name)
      || !(value instanceof Uint8Array)) {
      throw new TypeError(`pre-release advisory staging artifact ${name} is not owner-bound`);
    }
    const copied = new Uint8Array(value);
    if (identity.byteLength !== String(copied.byteLength)
      || identity.contentSha256 !== sha256Hex(copied)) {
      throw new TypeError(`pre-release advisory staging artifact ${name} identity mismatch`);
    }
    copies[name] = copied;
  }
  return Object.freeze(copies);
}

function assertReleaseBinding(
  label: string,
  actual: Readonly<{ readonly candidateReleaseCommit: string; readonly runtimeBindingId: string; readonly releaseProvenanceHash: string }>,
  expected: Readonly<{ readonly candidateReleaseCommit: string; readonly runtimeBindingId: string; readonly releaseProvenanceHash: string }>,
): void {
  if (actual.candidateReleaseCommit !== expected.candidateReleaseCommit
    || actual.runtimeBindingId !== expected.runtimeBindingId
    || actual.releaseProvenanceHash !== expected.releaseProvenanceHash) {
    throw new TypeError(`${label} does not exact-join frozen B`);
  }
}

function terminalArtifactReleaseBinding(
  bytes: Uint8Array,
  label: string,
): Readonly<{ readonly candidateReleaseCommit: string; readonly runtimeBindingId: string; readonly releaseProvenanceHash: string }> {
  const value = decodeCanonicalBytes(bytes) as Readonly<Record<string, unknown>>;
  if (value === null || typeof value !== "object"
    || typeof value.candidateReleaseCommit !== "string"
    || typeof value.runtimeBindingId !== "string"
    || typeof value.releaseProvenanceHash !== "string") {
    throw new TypeError(`${label} release binding is invalid`);
  }
  return Object.freeze({
    candidateReleaseCommit: value.candidateReleaseCommit,
    runtimeBindingId: value.runtimeBindingId,
    releaseProvenanceHash: value.releaseProvenanceHash,
  });
}

function assertAdvisoryMaterialCurrent(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
  material: PreReleaseAdvisoryMaterialV1,
): PreReleaseAdvisoryMaterialProjectionV1 {
  const projection = readPreReleaseAdvisoryMaterialCapabilityV1(capability);
  const lineage = readQualifiedReleaseLineageObservationV1(material.qualifiedReleaseRunner);
  const expected = Object.freeze({
    candidateReleaseCommit: lineage.boundary.candidateReleaseCommit,
    runtimeBindingId: lineage.runtimeBinding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(lineage.runtimeBinding),
  });
  const process = projection.processImportReceipt;
  const authorization = projection.signedAuthorization;
  if (projection.phase !== "pre-release"
    || projection.locators.advisoryJudgmentPath !== PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath
    || projection.authorizationClaim.phase !== "pre-release"
    || projection.authorizationClaim.roundRole !== "qualification-final"
    || authorization.dryRun !== true
    || authorization.roundRole !== "qualification-final"
    || authorization.permissions.sign !== false
    || authorization.permissions.broadcast !== false
    || authorization.permissions.promote !== false
    || process.dryRun !== true
    || process.processAnchorHash !== hashProcessAnchor(process.processAnchor)
    || projection.stagingArtifacts.length !== PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.length
    || authorization.candidateReleaseCommit !== expected.candidateReleaseCommit
    || authorization.runtimeBindingId !== expected.runtimeBindingId
    || authorization.releaseProvenanceHash !== expected.releaseProvenanceHash
    || authorization.releaseAuthorityApprovalId !== lineage.releaseAuthorityApproval.approvalId
    || authorization.releaseRoleManifestRoot !== lineage.boundary.releaseRoleManifestRoot
    || authorization.boundaryRunnerEntrypointId !== lineage.boundary.qualifiedRunnerEntrypointId
    || authorization.boundaryRunnerClosureDigest !== lineage.boundary.qualifiedRunnerClosureDigest
    || authorization.boundaryRunnerImplementationExportDigest !== lineage.boundary.qualifiedRunnerImplementationExportDigest
    || authorization.stagingArtifactSetRoot !== projection.stagingArtifactSetRoot
    || authorization.stagingManifestRoot !== projection.stagingManifestRoot
    || authorization.observerStoreDirectory !== projection.locators.observerStoreDirectory
    || process.candidateReleaseCommit !== expected.candidateReleaseCommit
    || process.runtimeBindingId !== expected.runtimeBindingId
    || process.releaseProvenanceHash !== expected.releaseProvenanceHash
    || process.stagingArtifactSetRoot !== projection.stagingArtifactSetRoot
    || process.stagingManifestRoot !== projection.stagingManifestRoot
    || !sameCanonical(process.stagingArtifacts, projection.stagingArtifacts)
    || process.authorizationId !== authorization.authorizationId
    || process.authorizationClaimId !== projection.authorizationClaim.claimId
    || process.observerStoreDirectory !== projection.locators.observerStoreDirectory
    || projection.authorizationClaim.authorizationId !== authorization.authorizationId
    || projection.authorizationClaim.candidateReleaseCommit !== expected.candidateReleaseCommit
    || projection.authorizationClaim.runtimeBindingId !== expected.runtimeBindingId
    || projection.authorizationClaim.releaseProvenanceHash !== expected.releaseProvenanceHash
    || projection.authorizationClaim.stagingArtifactSetRoot !== projection.stagingArtifactSetRoot
    || projection.authorizationClaim.stagingManifestRoot !== projection.stagingManifestRoot
    || projection.authorizationClaim.observerStoreDirectory !== projection.locators.observerStoreDirectory
    || projection.locators.restartProbeAuthorizationPath !== PRE_RELEASE_STAGING_LAYOUT_V1.restartProbeAuthorizationPath
    || projection.locators.qualificationFinalAuthorizationPath !== PRE_RELEASE_STAGING_LAYOUT_V1.qualificationFinalAuthorizationPath
    || projection.authorizationClaim.ledgerPath !== projection.locators.authorizationLedgerPath
    || process.manifestPath !== projection.locators.manifestPath
    || process.processEvidenceDatabasePath !== projection.locators.processEvidenceDatabasePath
    || process.checkpointDatabasePath !== projection.locators.checkpointDatabasePath
    || process.logPath !== projection.locators.logPath) {
    throw new TypeError("pre-release advisory material does not exact-join frozen B");
  }
  const sourceBinding = readReleaseOwnedObserverStoreV1(material.observerStore).authority;
  assertReleaseBinding("predicate material source composition", Object.freeze({
    candidateReleaseCommit: sourceBinding.candidateReleaseCommit,
    runtimeBindingId: sourceBinding.bindingId,
    releaseProvenanceHash: expected.releaseProvenanceHash,
  }), expected);
  assertProductionTerminalPhaseDurableDiscoveryV1(material.durableTerminalDiscovery);
  assertReleaseBinding("durable Full-Family terminal discovery", terminalArtifactReleaseBinding(
    material.durableTerminalDiscovery.fullFamilyTerminalBindingArtifact.bytes,
    "durable Full-Family terminal binding",
  ), expected);
  if (material.durableTerminalDiscovery.sixStepTerminalBindingArtifact !== null) {
    assertReleaseBinding("durable Six-Step terminal discovery", terminalArtifactReleaseBinding(
      material.durableTerminalDiscovery.sixStepTerminalBindingArtifact.bytes,
      "durable Six-Step terminal binding",
    ), expected);
  }
  assertReleaseBinding("performance observer", readProductionPerformanceMaterialObserverReleaseBindingV1(material.performanceObserver), expected);
  assertReleaseBinding("terminal-selection observer", readProductionTerminalSelectionObserverReleaseBindingV1(material.terminalSelectionObserver), expected);
  assertReleaseBinding("runtime-restart observer", readProductionRuntimeRestartMaterialObserverReleaseBindingV1(material.runtimeRestartObserver), expected);
  return projection;
}

function issueAdvisoryPredicateSource(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
  projection: PreReleaseAdvisoryMaterialProjectionV1,
  material: PreReleaseAdvisoryMaterialV1,
): ReturnType<typeof issueRootPredicateMaterialSourceV1> {
  const observerStore = material.observerStore;
  const closureObservers = issueProductionClosureMaterialObserverPortsV1({
    preReleaseAdvisoryMaterial: capability,
    qualifiedReleaseRunner: material.qualifiedReleaseRunner,
    observerStore,
  });
  return issueRootPredicateMaterialSourceV1(Object.freeze({
    observerStore,
    artifactLineageRepositoryRoot: projection.locators.repositoryRoot,
    performanceObserver: material.performanceObserver,
    durableTerminalDiscovery: material.durableTerminalDiscovery,
    terminalSelectionObserver: material.terminalSelectionObserver,
    runtimeRestartObserver: material.runtimeRestartObserver,
    sourceRepositoryClosureObserver: closureObservers.sourceRepository,
    legacyAuthorityClosureObserver: closureObservers.legacyAuthority,
  }));
}

function statusFor(
  evaluations: readonly AssembledPredicateEvaluationV1[],
  terminalSnapshotTrustRoot: Hash | null,
): ProductionReleaseAcceptanceAdvisoryStatusV1 {
  if (terminalSnapshotTrustRoot === null) return "incomplete";
  if (evaluations.some(evaluation => evaluation.status === "invalid" || evaluation.verdict === "invalid")) return "invalid";
  if (evaluations.length === 0 || evaluations.some(evaluation => evaluation.status === "missing" || evaluation.verdict === null)) return "incomplete";
  if (evaluations.some(evaluation => evaluation.verdict === "fail")) return "fail";
  return evaluations.every(evaluation => evaluation.status === "evaluated" && evaluation.verdict === "pass")
    ? "pass"
    : "incomplete";
}

function reasonsFor(
  evaluations: readonly AssembledPredicateEvaluationV1[],
  terminalSnapshotTrustRoot: Hash | null,
): readonly ProductionReleaseAcceptanceAdvisoryReasonV1[] {
  const reasons: ProductionReleaseAcceptanceAdvisoryReasonV1[] = [];
  for (const evaluation of evaluations) {
    if (evaluation.status === "missing" || evaluation.verdict === null) {
      reasons.push(Object.freeze({ predicateId: evaluation.predicateId, code: evaluation.unavailableCode ?? "predicate-material-incomplete" }));
    } else if (evaluation.status === "invalid" || evaluation.verdict === "invalid") {
      reasons.push(Object.freeze({ predicateId: evaluation.predicateId, code: evaluation.unavailableCode ?? "predicate-evaluation-invalid" }));
    } else if (evaluation.verdict === "fail") {
      reasons.push(Object.freeze({ predicateId: evaluation.predicateId, code: "predicate-verdict-fail" }));
    }
  }
  if (terminalSnapshotTrustRoot === null) {
    reasons.push(Object.freeze({
      predicateId: "aloha.pre-release-terminal-snapshot-trust.v1",
      code: "terminal-snapshot-trust-root-missing",
    }));
  }
  return Object.freeze(reasons);
}

function observeNominationQualificationReuseAdvisoryV1(
  capability?: PreReleaseAdvisoryMaterialCapabilityV1,
): ProductionNominationQualificationReuseObservationV1 {
  if (capability === undefined) return Object.freeze({
    status: "unavailable" as const,
    code: "verified-release-authority-composition-unavailable" as const,
    advisoryOnly: true as const,
  });
  const observation = observeProductionNominationQualificationReuseCompositionV1(capability);
  if (observation.status === "unavailable") return observation;
  const consumer = createNominationQualificationReuseConsumerV1(observation.composition);
  const preSignReport = consumer.analyzePreSign();
  const postSignInput = readProductionNominationQualificationReusePostSignInputV1(observation.composition);
  const postSignReport = consumer.verifyPostSign(postSignInput);
  return Object.freeze({
    status: "available" as const,
    advisoryOnly: true as const,
    preSignReport,
    postSignReport,
  });
}

export function createProductionReleaseAcceptanceAdvisoryReportV1(
  projection: PreReleaseAdvisoryMaterialProjectionV1,
  evaluationsValue: readonly AssembledPredicateEvaluationV1[],
  judgedAtUnixNs: string,
  terminalSnapshotTrustRoot: Hash | null,
  factIndex: ProductionReleaseAcceptanceAdvisoryFactIndexV1,
  checkpointSnapshotPublication: PreReleaseControllerDatabaseSnapshotPublicationV1,
  nominationQualificationMaterial?: PreReleaseAdvisoryMaterialCapabilityV1,
): ProductionReleaseAcceptanceAdvisoryReportV1 {
  const evaluations = Object.freeze(evaluationsValue.map(evaluation => Object.freeze({ ...evaluation })));
  const process = projection.processImportReceipt;
  const nominationQualificationReuse = observeNominationQualificationReuseAdvisoryV1(nominationQualificationMaterial);
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.pre-release-acceptance-advisory-judgment" as const,
    status: statusFor(evaluations, terminalSnapshotTrustRoot),
    reasons: reasonsFor(evaluations, terminalSnapshotTrustRoot),
    release: Object.freeze({ candidateReleaseCommit: process.candidateReleaseCommit, runtimeBindingId: process.runtimeBindingId, releaseProvenanceHash: process.releaseProvenanceHash }),
    physicalProcess: Object.freeze({ processAnchorHash: process.processAnchorHash, pid: process.processAnchor.pid, processStartTicks: process.processAnchor.processStartTicks, bootIdHash: process.processAnchor.bootIdHash, executableHash: process.processAnchor.executableHash, dryRun: true as const }),
    authority: Object.freeze({ advisoryOnly: true as const, candidateGeneratedAuthority: null, runtimeReleaseBinding: null, releaseAuthority: null, submissionAuthority: null, sign: false as const, broadcast: false as const, promote: false as const }),
    factBinding: Object.freeze({
      processImportReceiptId: process.receiptId,
      databaseContentSha256: process.databaseContentSha256,
      terminalSnapshotTrustRoot,
    }),
    factLocators: Object.freeze({
      processEvidenceDatabasePath: process.processEvidenceDatabasePath,
      checkpointDatabasePath: process.checkpointDatabasePath,
      frozenCheckpointSnapshotPublication: checkpointSnapshotPublication,
      observerStoreDirectory: process.observerStoreDirectory,
      authorizationLedgerPath: projection.authorizationClaim.ledgerPath,
      processEvidenceDatabase: Object.freeze({
        path: process.processEvidenceDatabasePath,
        device: process.databaseDevice,
        inode: process.databaseInode,
        contentSha256: process.databaseContentSha256,
      }),
      logWindow: Object.freeze({ path: process.logPath, device: process.logDevice, inode: process.logInode, startInclusive: process.logStartInclusive, endExclusive: process.logEndExclusive, contentSha256: process.logContentSha256 }),
    }),
    artifactLocators: Object.freeze(projection.stagingArtifacts.map(value => Object.freeze({ ...value }))),
    factIndex,
    evaluations,
    nominationQualificationReuse,
    judgedAtUnixNs,
  });
  return Object.freeze({ ...payload, judgmentRoot: hashDomain("aloha/pre-release-acceptance-advisory-judgment/v1", payload as never) });
}

/** Observe frozen-B facts without crossing the prepared-acceptance bridge. */
export async function observeProductionReleaseAcceptanceAdvisoryV1(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
): Promise<ProductionReleaseAcceptanceAdvisoryReportV1> {
  if (arguments.length !== 1) throw new TypeError("production acceptance advisory accepts one advisory material capability");
  const material = readPreReleaseAdvisoryMaterialV1(capability);
  const projection = assertAdvisoryMaterialCurrent(capability, material);
  readAdvisoryStagingArtifactBytes(projection, material);
  const source = issueAdvisoryPredicateSource(capability, projection, material);
  const result = await observeQualifiedReleaseAcceptanceAdvisoryV1(material.qualifiedReleaseRunner, source);
  const terminalSnapshotTrustRoot = material.durableTerminalDiscovery.snapshotTrustRoot;
  const factIndex = buildProductionReleaseAcceptanceAdvisoryFactIndexV1(
    projection.locators.processEvidenceDatabasePath,
    material.durableTerminalDiscovery,
  );
  return createProductionReleaseAcceptanceAdvisoryReportV1(
    projection,
    result.evaluations,
    (BigInt(Date.now()) * 1_000_000n).toString(),
    terminalSnapshotTrustRoot,
    factIndex,
    material.checkpointSnapshotPublication,
    capability,
  );
}

/** Re-evaluate the frozen-B denominator through the qualified runner and
 * return only the canonical bytes an external signer must approve. Advisory
 * judgments and Fact Log output are deliberately not inputs to this path. */
export async function prepareProductionReleaseAcceptanceForExternalOwnerV1(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
): Promise<ProductionReleaseAcceptancePreparationCapabilityV1> {
  if (arguments.length !== 1) throw new TypeError("production release acceptance preparation accepts one advisory material capability");
  const material = readPreReleaseAdvisoryMaterialV1(capability);
  const projection = assertAdvisoryMaterialCurrent(capability, material);
  readAdvisoryStagingArtifactBytes(projection, material);
  const source = issueAdvisoryPredicateSource(capability, projection, material);
  const run = await prepareQualifiedReleaseAcceptanceForExternalOwnerV1(
    material.qualifiedReleaseRunner,
    source,
  );
  const prepared = run.preparedAcceptance;
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.release-acceptance-signing-request" as const,
    acceptanceCertificates: prepared.acceptanceCertificates,
    releaseAcceptanceSet: prepared.releaseAcceptanceSet,
    signingInput: prepared.signingInput,
    signingBytesHex: `0x${Buffer.from(prepared.signingBytes).toString("hex")}`,
  });
  const signingRequest = Object.freeze({
    ...payload,
    requestRoot: hashDomain("aloha/release-acceptance-signing-request/v1", payload as never),
  });
  const preparation = Object.freeze(Object.create(null));
  productionReleaseAcceptancePreparations.set(preparation, Object.freeze({
    preparedAcceptance: prepared,
    signingRequest,
  }));
  return preparation;
}

function readProductionReleaseAcceptancePreparationStateV1(
  capability: ProductionReleaseAcceptancePreparationCapabilityV1,
): ProductionReleaseAcceptancePreparationStateV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("production release acceptance preparation capability is invalid");
  }
  const state = productionReleaseAcceptancePreparations.get(capability);
  if (state === undefined) {
    throw new TypeError("production release acceptance preparation was not qualified-runner-issued");
  }
  return state;
}

export function readProductionReleaseAcceptanceSigningRequestV1(
  capability: ProductionReleaseAcceptancePreparationCapabilityV1,
): ProductionReleaseAcceptanceSigningRequestV1 {
  return readProductionReleaseAcceptancePreparationStateV1(capability).signingRequest;
}

export function readProductionReleasePreparedAcceptanceV1(
  capability: ProductionReleaseAcceptancePreparationCapabilityV1,
): ProductionReleaseAcceptancePreparationStateV1["preparedAcceptance"] {
  return readProductionReleaseAcceptancePreparationStateV1(capability).preparedAcceptance;
}

export async function prepareProductionReleaseAcceptanceSigningRequestV1(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
): Promise<ProductionReleaseAcceptanceSigningRequestV1> {
  return readProductionReleaseAcceptanceSigningRequestV1(
    await prepareProductionReleaseAcceptanceForExternalOwnerV1(capability),
  );
}
