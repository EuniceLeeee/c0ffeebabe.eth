import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertPlainObject,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  observeProductionPerformanceDatabaseV1,
  type ObservedProductionEventV1,
  type RawPerformanceObservationV1,
} from "../../../packages/performance-collector/src/index.ts";
import {
  validateMaterializedFullGraphSweepV1,
  validateNativeFullFamilyAuditWireV1,
} from "../../../acceptance/collectors/src/full-family-observer.ts";
import {
  decodeNativeFullFamilyAuditV1,
  decodeNativeFullFamilyAuditManifestV1,
  encodeNativeFullFamilyAuditBodyV1,
  type NativeFullFamilyAuditV1,
} from "../../../packages/search-pipeline/src/index.ts";
import {
  decodeFullGraphCoarseSweepManifestV1,
  decodeFullGraphCoarseSweepV1,
  encodeFullGraphCoarseSweepV1,
  type FullGraphCoarseSweepV1,
} from "../../../packages/full-graph-coarse-sweep/src/index.ts";
import {
  assertActiveReadyGraphCoarseSweepDenominatorV1,
  observeFrozenPreReleaseBActiveReadyGraphV1,
  type ProductionActiveReadyGraphSnapshotV1,
} from "../../runtime-release-packager/src/pre-release-b-active-ready-graph-observer.ts";
import {
  readPreReleaseBTerminalPhysicalObservationV1,
  type PreReleaseBTerminalPhysicalObservationCapabilityV1,
  type PreReleaseBTerminalPhysicalObservationV1,
} from "../../runtime-release-packager/src/pre-release-b-terminal-physical-observation.ts";
import type {
  PreReleaseControllerDatabaseSnapshotPublicationV1,
} from "../../pre-release-restart-controller/src/durable-owner.ts";
import { PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 } from "../../pre-release-restart-controller/src/spec.ts";

type LaneV1 = "blockscan" | "backrun";

export interface PreReleaseFactLogRecordV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly schemaVersion: 1;
  readonly kind: string;
}

interface PhysicalFileExpectationV1 {
  readonly device?: string;
  readonly inode?: string;
  readonly contentSha256?: Hash;
  readonly byteLength?: string;
  readonly requireWriteOnce?: boolean;
}

interface NominationQualificationEntryV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly proposalLeafDigest: Hash;
  readonly criticalMutationCorpusRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly verifierQualificationCertificateRoot: Hash;
  readonly qualificationLeafDigest: Hash;
}

interface ReusedFamilyNominationQualificationV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly familyId: string;
  readonly artifactId: string;
  readonly nominationProposalLeafDigests: readonly Hash[];
  readonly nominationQualificationEntries: readonly NominationQualificationEntryV1[];
}

interface FamilyNominationRequalificationDenominatorV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly familyId: string;
  readonly artifactId: string;
  readonly nominationProposalLeafDigests: readonly Hash[];
  readonly reason: "catalog-impact-affected";
}

interface NominationQualificationPreSignReportV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly schemaVersion: 1;
  readonly kind: "aloha.nomination-qualification-pre-sign-report";
  readonly advisoryOnly: true;
  readonly priorDeploymentFactId: Hash;
  readonly priorRuntimeBindingId: Hash;
  readonly priorSnapshotRoot: Hash;
  readonly currentSnapshotRoot: Hash;
  readonly currentFamilyProposalOwnershipRoot: Hash;
  readonly currentSemanticLedgerHash: Hash;
  readonly currentSemanticOutputRoot: Hash;
  readonly currentBoundaryVerificationReceiptRoot: Hash;
  readonly reusedFamilies: readonly ReusedFamilyNominationQualificationV1[];
  readonly requalificationDenominator: readonly FamilyNominationRequalificationDenominatorV1[];
  readonly reportRoot: Hash;
}

interface NominationQualificationPostSignReportV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly schemaVersion: 1;
  readonly kind: "aloha.nomination-qualification-post-sign-report";
  readonly advisoryOnly: true;
  readonly preSignReportRoot: Hash;
  readonly currentDeploymentFactId: Hash;
  readonly currentRuntimeBindingId: Hash;
  readonly currentSnapshotRoot: Hash;
  readonly verifiedQualificationEntryCount: number;
  readonly reportRoot: Hash;
}

type NominationQualificationReuseObservationV1 =
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

interface AdvisoryReportV1 {
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
  readonly factBinding: Readonly<{
    readonly processImportReceiptId: Hash;
    readonly databaseContentSha256: Hash;
    readonly terminalSnapshotTrustRoot: Hash | null;
  }>;
  readonly factIndex: Readonly<{
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
      readonly locator: Readonly<{ readonly locatorRoot: Hash; readonly artifactRefId: Hash; readonly contentSha256: Hash }>;
      readonly manifest: Readonly<{ readonly manifestRoot: Hash; readonly artifactRefId: Hash; readonly contentSha256: Hash }>;
      readonly fullFamilyTerminalBinding: Readonly<{ readonly artifactRefId: Hash; readonly contentSha256: Hash }>;
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
        readonly candidate: Readonly<Record<string, CanonicalJson>>;
      }>;
      readonly exactAdmission: Readonly<{
        readonly sourcePath: "payload.accounting.entries[].disposition";
        readonly disposition: "selected";
      }>;
    }>;
  }>;
  readonly nominationQualificationReuse: NominationQualificationReuseObservationV1;
  readonly judgmentRoot: Hash;
}

interface AccountedRoutePayloadV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly lane: LaneV1;
  readonly correlationId: Hash;
  readonly coverageRoot: Hash;
  readonly denominatorKind: "accounted";
  readonly accounting: Readonly<Record<string, CanonicalJson>> & {
    readonly entries: readonly (Readonly<Record<string, CanonicalJson>> & {
      readonly candidateId: Hash;
      readonly disposition: string;
    })[];
    readonly root: Hash;
  };
}

interface NoInputRoutePayloadV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly lane: "backrun";
  readonly correlationId: Hash;
  readonly coverageRoot: Hash;
  readonly denominatorKind: "no-input";
}

type RoutePayloadV1 = AccountedRoutePayloadV1 | NoInputRoutePayloadV1;

interface CandidateSetPayloadV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly laneDenominators: readonly (Readonly<Record<string, CanonicalJson>> & {
    readonly lane: LaneV1;
    readonly correlationId: Hash;
    readonly coverageRoot: Hash;
    readonly accountingRoot: Hash;
  })[];
  readonly candidateTerminalObservations: readonly (Readonly<Record<string, CanonicalJson>> & {
    readonly lane: LaneV1;
    readonly candidateId: Hash;
  })[];
}

function ownRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  assertPlainObject(value, path);
  return value as Readonly<Record<string, unknown>>;
}

function absolutePath(value: unknown, path: string): string {
  if (typeof value !== "string" || value.includes("\0") || !value.startsWith("/") || resolve(value) !== value) {
    throw new TypeError(`${path} must be a canonical absolute path`);
  }
  return value;
}

function hash(value: unknown, path: string): Hash {
  const observed = assertHash(value, path);
  if (observed === `0x${"0".repeat(64)}`) throw new TypeError(`${path} must be non-zero`);
  return observed;
}

function exactLiteral<T extends string | number | boolean | null>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new TypeError(`${path} mismatch`);
  return expected;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function hashArray(value: unknown, path: string): readonly Hash[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return Object.freeze(value.map((entry, index) => hash(entry, `${path}[${index}]`)));
}

function decodeCheckpointSnapshotPublication(
  value: unknown,
  path: string,
): PreReleaseControllerDatabaseSnapshotPublicationV1 {
  const publication = ownRecord(value, path);
  assertExactKeys(publication, [
    "sourcePath", "snapshotPath", "contentSha256", "byteLength", "device", "inode",
    "uid", "gid", "mode", "fileFsynced", "directoryFsynced",
  ], path);
  return Object.freeze({
    sourcePath: absolutePath(publication.sourcePath, `${path}.sourcePath`),
    snapshotPath: absolutePath(publication.snapshotPath, `${path}.snapshotPath`),
    contentSha256: hash(publication.contentSha256, `${path}.contentSha256`),
    byteLength: assertDecimalString(publication.byteLength, `${path}.byteLength`),
    device: assertDecimalString(publication.device, `${path}.device`),
    inode: assertDecimalString(publication.inode, `${path}.inode`),
    uid: exactLiteral(publication.uid, "0", `${path}.uid`),
    gid: exactLiteral(publication.gid, "0", `${path}.gid`),
    mode: exactLiteral(publication.mode, "384", `${path}.mode`),
    fileFsynced: exactLiteral(publication.fileFsynced, true, `${path}.fileFsynced`),
    directoryFsynced: exactLiteral(publication.directoryFsynced, true, `${path}.directoryFsynced`),
  });
}

function decodeNominationQualificationEntry(
  value: unknown,
  path: string,
): NominationQualificationEntryV1 {
  const entry = ownRecord(value, path);
  assertExactKeys(entry, [
    "proposalLeafDigest", "criticalMutationCorpusRoot", "independentOracleCaseRoot",
    "qualificationSpecDigest", "verifierQualificationCertificateRoot", "qualificationLeafDigest",
  ], path);
  return Object.freeze({
    proposalLeafDigest: hash(entry.proposalLeafDigest, `${path}.proposalLeafDigest`),
    criticalMutationCorpusRoot: hash(entry.criticalMutationCorpusRoot, `${path}.criticalMutationCorpusRoot`),
    independentOracleCaseRoot: hash(entry.independentOracleCaseRoot, `${path}.independentOracleCaseRoot`),
    qualificationSpecDigest: hash(entry.qualificationSpecDigest, `${path}.qualificationSpecDigest`),
    verifierQualificationCertificateRoot: hash(
      entry.verifierQualificationCertificateRoot,
      `${path}.verifierQualificationCertificateRoot`,
    ),
    qualificationLeafDigest: hash(entry.qualificationLeafDigest, `${path}.qualificationLeafDigest`),
  });
}

function decodeReusedFamily(value: unknown, path: string): ReusedFamilyNominationQualificationV1 {
  const family = ownRecord(value, path);
  assertExactKeys(family, [
    "familyId", "artifactId", "nominationProposalLeafDigests", "nominationQualificationEntries",
  ], path);
  const nominationProposalLeafDigests = hashArray(
    family.nominationProposalLeafDigests,
    `${path}.nominationProposalLeafDigests`,
  );
  if (!Array.isArray(family.nominationQualificationEntries)) {
    throw new TypeError(`${path}.nominationQualificationEntries must be an array`);
  }
  const nominationQualificationEntries = Object.freeze(family.nominationQualificationEntries.map(
    (entry, index) => decodeNominationQualificationEntry(entry, `${path}.nominationQualificationEntries[${index}]`),
  ));
  if (nominationProposalLeafDigests.length !== nominationQualificationEntries.length
    || nominationProposalLeafDigests.some((proposal, index) => (
      nominationQualificationEntries[index]?.proposalLeafDigest !== proposal
    ))) {
    throw new TypeError(`${path} proposal/qualification entry partition mismatch`);
  }
  return Object.freeze({
    familyId: nonEmptyString(family.familyId, `${path}.familyId`),
    artifactId: nonEmptyString(family.artifactId, `${path}.artifactId`),
    nominationProposalLeafDigests,
    nominationQualificationEntries,
  });
}

function decodeRequalificationDenominator(
  value: unknown,
  path: string,
): FamilyNominationRequalificationDenominatorV1 {
  const denominator = ownRecord(value, path);
  assertExactKeys(denominator, [
    "familyId", "artifactId", "nominationProposalLeafDigests", "reason",
  ], path);
  return Object.freeze({
    familyId: nonEmptyString(denominator.familyId, `${path}.familyId`),
    artifactId: nonEmptyString(denominator.artifactId, `${path}.artifactId`),
    nominationProposalLeafDigests: hashArray(
      denominator.nominationProposalLeafDigests,
      `${path}.nominationProposalLeafDigests`,
    ),
    reason: exactLiteral(denominator.reason, "catalog-impact-affected", `${path}.reason`),
  });
}

function decodeNominationQualificationPreSignReport(
  value: unknown,
  path: string,
): NominationQualificationPreSignReportV1 {
  const report = ownRecord(value, path);
  assertExactKeys(report, [
    "schemaVersion", "kind", "advisoryOnly", "priorDeploymentFactId", "priorRuntimeBindingId",
    "priorSnapshotRoot", "currentSnapshotRoot", "currentFamilyProposalOwnershipRoot",
    "currentSemanticLedgerHash", "currentSemanticOutputRoot", "currentBoundaryVerificationReceiptRoot",
    "reusedFamilies", "requalificationDenominator", "reportRoot",
  ], path);
  if (!Array.isArray(report.reusedFamilies)) throw new TypeError(`${path}.reusedFamilies must be an array`);
  if (!Array.isArray(report.requalificationDenominator)) {
    throw new TypeError(`${path}.requalificationDenominator must be an array`);
  }
  const reusedFamilies = Object.freeze(report.reusedFamilies.map(
    (family, index) => decodeReusedFamily(family, `${path}.reusedFamilies[${index}]`),
  ));
  const requalificationDenominator = Object.freeze(report.requalificationDenominator.map(
    (family, index) => decodeRequalificationDenominator(family, `${path}.requalificationDenominator[${index}]`),
  ));
  const base = Object.freeze({
    schemaVersion: exactLiteral(report.schemaVersion, 1, `${path}.schemaVersion`),
    kind: exactLiteral(
      report.kind,
      "aloha.nomination-qualification-pre-sign-report",
      `${path}.kind`,
    ),
    advisoryOnly: exactLiteral(report.advisoryOnly, true, `${path}.advisoryOnly`),
    priorDeploymentFactId: hash(report.priorDeploymentFactId, `${path}.priorDeploymentFactId`),
    priorRuntimeBindingId: hash(report.priorRuntimeBindingId, `${path}.priorRuntimeBindingId`),
    priorSnapshotRoot: hash(report.priorSnapshotRoot, `${path}.priorSnapshotRoot`),
    currentSnapshotRoot: hash(report.currentSnapshotRoot, `${path}.currentSnapshotRoot`),
    currentFamilyProposalOwnershipRoot: hash(
      report.currentFamilyProposalOwnershipRoot,
      `${path}.currentFamilyProposalOwnershipRoot`,
    ),
    currentSemanticLedgerHash: hash(report.currentSemanticLedgerHash, `${path}.currentSemanticLedgerHash`),
    currentSemanticOutputRoot: hash(report.currentSemanticOutputRoot, `${path}.currentSemanticOutputRoot`),
    currentBoundaryVerificationReceiptRoot: hash(
      report.currentBoundaryVerificationReceiptRoot,
      `${path}.currentBoundaryVerificationReceiptRoot`,
    ),
    reusedFamilies,
    requalificationDenominator,
  });
  const reportRoot = hash(report.reportRoot, `${path}.reportRoot`);
  if (reportRoot !== hashDomain("aloha/nomination-qualification-pre-sign-report/v1", base)) {
    throw new TypeError(`${path}.reportRoot mismatch`);
  }
  return Object.freeze({ ...base, reportRoot });
}

function decodeNominationQualificationPostSignReport(
  value: unknown,
  path: string,
): NominationQualificationPostSignReportV1 {
  const report = ownRecord(value, path);
  assertExactKeys(report, [
    "schemaVersion", "kind", "advisoryOnly", "preSignReportRoot", "currentDeploymentFactId",
    "currentRuntimeBindingId", "currentSnapshotRoot", "verifiedQualificationEntryCount", "reportRoot",
  ], path);
  if (!Number.isSafeInteger(report.verifiedQualificationEntryCount)
    || (report.verifiedQualificationEntryCount as number) < 0) {
    throw new TypeError(`${path}.verifiedQualificationEntryCount must be a non-negative safe integer`);
  }
  const base = Object.freeze({
    schemaVersion: exactLiteral(report.schemaVersion, 1, `${path}.schemaVersion`),
    kind: exactLiteral(
      report.kind,
      "aloha.nomination-qualification-post-sign-report",
      `${path}.kind`,
    ),
    advisoryOnly: exactLiteral(report.advisoryOnly, true, `${path}.advisoryOnly`),
    preSignReportRoot: hash(report.preSignReportRoot, `${path}.preSignReportRoot`),
    currentDeploymentFactId: hash(report.currentDeploymentFactId, `${path}.currentDeploymentFactId`),
    currentRuntimeBindingId: hash(report.currentRuntimeBindingId, `${path}.currentRuntimeBindingId`),
    currentSnapshotRoot: hash(report.currentSnapshotRoot, `${path}.currentSnapshotRoot`),
    verifiedQualificationEntryCount: report.verifiedQualificationEntryCount as number,
  });
  const reportRoot = hash(report.reportRoot, `${path}.reportRoot`);
  if (reportRoot !== hashDomain("aloha/nomination-qualification-post-sign-report/v1", base)) {
    throw new TypeError(`${path}.reportRoot mismatch`);
  }
  return Object.freeze({ ...base, reportRoot });
}

function decodeNominationQualificationReuse(value: unknown): NominationQualificationReuseObservationV1 {
  const observation = ownRecord(value, "report.nominationQualificationReuse");
  if (observation.status === "unavailable") {
    assertExactKeys(observation, ["status", "code", "advisoryOnly"], "report.nominationQualificationReuse");
    return Object.freeze({
      status: "unavailable" as const,
      code: exactLiteral(
        observation.code,
        "verified-release-authority-composition-unavailable",
        "report.nominationQualificationReuse.code",
      ),
      advisoryOnly: exactLiteral(
        observation.advisoryOnly,
        true,
        "report.nominationQualificationReuse.advisoryOnly",
      ),
    });
  }
  exactLiteral(observation.status, "available", "report.nominationQualificationReuse.status");
  assertExactKeys(
    observation,
    ["status", "advisoryOnly", "preSignReport", "postSignReport"],
    "report.nominationQualificationReuse",
  );
  exactLiteral(observation.advisoryOnly, true, "report.nominationQualificationReuse.advisoryOnly");
  const preSignReport = decodeNominationQualificationPreSignReport(
    observation.preSignReport,
    "report.nominationQualificationReuse.preSignReport",
  );
  const postSignReport = decodeNominationQualificationPostSignReport(
    observation.postSignReport,
    "report.nominationQualificationReuse.postSignReport",
  );
  if (postSignReport.preSignReportRoot !== preSignReport.reportRoot) {
    throw new TypeError("report nomination qualification post/pre root binding mismatch");
  }
  if (postSignReport.currentSnapshotRoot !== preSignReport.currentSnapshotRoot) {
    throw new TypeError("report nomination qualification current snapshot binding mismatch");
  }
  const familyIds = new Set<string>();
  const artifactIds = new Set<string>();
  const proposalLeafDigests = new Set<Hash>();
  let proposalCount = 0;
  for (const [partition, families] of [
    ["reusedFamilies", preSignReport.reusedFamilies],
    ["requalificationDenominator", preSignReport.requalificationDenominator],
  ] as const) {
    for (const family of families) {
      if (family.nominationProposalLeafDigests.length === 0) {
        throw new TypeError(`report nomination qualification ${partition} Family proposal set must be non-empty`);
      }
      if (familyIds.has(family.familyId)) {
        throw new TypeError("report nomination qualification Family partition must be globally unique and disjoint");
      }
      familyIds.add(family.familyId);
      if (artifactIds.has(family.artifactId)) {
        throw new TypeError("report nomination qualification artifact partition must be globally unique and disjoint");
      }
      artifactIds.add(family.artifactId);
      for (const proposalLeafDigest of family.nominationProposalLeafDigests) {
        if (proposalLeafDigests.has(proposalLeafDigest)) {
          throw new TypeError("report nomination qualification proposal partition must be globally unique and disjoint");
        }
        proposalLeafDigests.add(proposalLeafDigest);
        proposalCount += 1;
      }
    }
  }
  if (proposalCount !== postSignReport.verifiedQualificationEntryCount) {
    throw new TypeError("report nomination qualification proposal partition must equal verified entry count");
  }
  return Object.freeze({ status: "available" as const, advisoryOnly: true as const, preSignReport, postSignReport });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const leftBytes = encodeCanonicalBytes(left);
  const rightBytes = encodeCanonicalBytes(right);
  return leftBytes.byteLength === rightBytes.byteLength
    && leftBytes.every((value, index) => value === rightBytes[index]);
}

function sameOrderedHashes(left: readonly Hash[], right: readonly Hash[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const EXPECTED_JOIN_CONTRACT_V1 = Object.freeze({
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
    routeEntriesPath: "payload.accounting.entries",
    terminalObservationsPath: "payload.candidateTerminalObservations",
    routeLanePath: "payload.lane",
    terminalLanePath: "lane",
    identity: Object.freeze({ routePath: "candidateId", terminalPath: "candidateId" }),
    matching: "filter-terminal-by-route-lane-then-exact-order-and-cardinality",
    equalFields: Object.freeze([
      "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal",
    ]),
  }),
});

function readPhysicalFile(path: string, expected: PhysicalFileExpectationV1): Uint8Array {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new TypeError(`${path} is not a physical file`);
    if (expected.device !== undefined && before.dev.toString() !== expected.device) {
      throw new TypeError(`${path} device changed`);
    }
    if (expected.inode !== undefined && before.ino.toString() !== expected.inode) {
      throw new TypeError(`${path} inode changed`);
    }
    if (expected.byteLength !== undefined && before.size.toString() !== expected.byteLength) {
      throw new TypeError(`${path} byte length changed`);
    }
    if (expected.requireWriteOnce === true && (before.nlink !== 1n || (before.mode & 0o222n) !== 0n)) {
      throw new TypeError(`${path} is not a write-once physical file`);
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`${path} is too large`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new TypeError(`${path} was truncated during read`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new TypeError(`${path} changed during read`);
    }
    const concrete = new Uint8Array(bytes);
    if (expected.contentSha256 !== undefined && sha256Hex(concrete) !== expected.contentSha256) {
      throw new TypeError(`${path} content hash changed`);
    }
    const pathDescriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(pathDescriptor, { bigint: true });
      if (current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size
        || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) {
        throw new TypeError(`${path} locator changed during read`);
      }
    } finally {
      closeSync(pathDescriptor);
    }
    return concrete;
  } finally {
    closeSync(descriptor);
  }
}

function decodeReport(value: unknown): AdvisoryReportV1 {
  const report = ownRecord(value, "report");
  assertExactKeys(report, [
    "schemaVersion", "kind", "status", "reasons", "release", "physicalProcess", "authority",
    "factBinding", "factLocators", "artifactLocators", "factIndex", "evaluations", "nominationQualificationReuse",
    "judgedAtUnixNs", "judgmentRoot",
  ], "report");
  exactLiteral(report.schemaVersion, 1, "report.schemaVersion");
  exactLiteral(report.kind, "aloha.pre-release-acceptance-advisory-judgment", "report.kind");
  const judgmentRoot = hash(report.judgmentRoot, "report.judgmentRoot");
  const { judgmentRoot: _judgmentRoot, ...judgmentPayload } = report;
  if (judgmentRoot !== hashDomain(
    "aloha/pre-release-acceptance-advisory-judgment/v1",
    judgmentPayload as CanonicalJson,
  )) {
    throw new TypeError("report.judgmentRoot mismatch");
  }
  const nominationQualificationReuse = decodeNominationQualificationReuse(report.nominationQualificationReuse);
  const authority = ownRecord(report.authority, "report.authority");
  assertExactKeys(authority, [
    "advisoryOnly", "candidateGeneratedAuthority", "runtimeReleaseBinding", "releaseAuthority",
    "submissionAuthority", "sign", "broadcast", "promote",
  ], "report.authority");
  exactLiteral(authority.advisoryOnly, true, "report.authority.advisoryOnly");
  for (const key of ["candidateGeneratedAuthority", "runtimeReleaseBinding", "releaseAuthority", "submissionAuthority"] as const) {
    exactLiteral(authority[key], null, `report.authority.${key}`);
  }
  for (const key of ["sign", "broadcast", "promote"] as const) exactLiteral(authority[key], false, `report.authority.${key}`);

  const releaseValue = ownRecord(report.release, "report.release");
  assertExactKeys(releaseValue, ["candidateReleaseCommit", "runtimeBindingId", "releaseProvenanceHash"], "report.release");
  const release = Object.freeze({
    candidateReleaseCommit: gitSha40Schema.decode(releaseValue.candidateReleaseCommit, "report.release.candidateReleaseCommit"),
    runtimeBindingId: hash(releaseValue.runtimeBindingId, "report.release.runtimeBindingId"),
    releaseProvenanceHash: hash(releaseValue.releaseProvenanceHash, "report.release.releaseProvenanceHash"),
  });
  const physicalProcessValue = ownRecord(report.physicalProcess, "report.physicalProcess");
  assertExactKeys(physicalProcessValue, [
    "processAnchorHash", "pid", "processStartTicks", "bootIdHash", "executableHash", "dryRun",
  ], "report.physicalProcess");
  exactLiteral(physicalProcessValue.dryRun, true, "report.physicalProcess.dryRun");
  const physicalProcess = Object.freeze({
    processAnchorHash: hash(physicalProcessValue.processAnchorHash, "report.physicalProcess.processAnchorHash"),
    pid: assertDecimalString(physicalProcessValue.pid, "report.physicalProcess.pid"),
    processStartTicks: assertDecimalString(physicalProcessValue.processStartTicks, "report.physicalProcess.processStartTicks"),
    bootIdHash: hash(physicalProcessValue.bootIdHash, "report.physicalProcess.bootIdHash"),
    executableHash: hash(physicalProcessValue.executableHash, "report.physicalProcess.executableHash"),
    dryRun: true as const,
  });
  if (nominationQualificationReuse.status === "available"
    && nominationQualificationReuse.postSignReport.currentRuntimeBindingId !== release.runtimeBindingId) {
    throw new TypeError("report nomination qualification current runtime binding does not join report release");
  }

  const locatorsValue = ownRecord(report.factLocators, "report.factLocators");
  const factBindingValue = ownRecord(report.factBinding, "report.factBinding");
  assertExactKeys(factBindingValue, [
    "processImportReceiptId", "databaseContentSha256", "terminalSnapshotTrustRoot",
  ], "report.factBinding");
  assertExactKeys(locatorsValue, [
    "processEvidenceDatabasePath", "checkpointDatabasePath", "frozenCheckpointSnapshotPublication",
    "observerStoreDirectory", "authorizationLedgerPath", "processEvidenceDatabase", "logWindow",
  ], "report.factLocators");
  const processDatabaseValue = ownRecord(locatorsValue.processEvidenceDatabase, "report.factLocators.processEvidenceDatabase");
  const processEvidenceDatabase = Object.freeze({
    path: absolutePath(processDatabaseValue.path, "report.factLocators.processEvidenceDatabase.path"),
    device: assertDecimalString(processDatabaseValue.device, "report.factLocators.processEvidenceDatabase.device"),
    inode: assertDecimalString(processDatabaseValue.inode, "report.factLocators.processEvidenceDatabase.inode"),
    contentSha256: hash(processDatabaseValue.contentSha256, "report.factLocators.processEvidenceDatabase.contentSha256"),
  });
  const processEvidenceDatabasePath = absolutePath(locatorsValue.processEvidenceDatabasePath, "report.factLocators.processEvidenceDatabasePath");
  const checkpointDatabasePath = absolutePath(
    locatorsValue.checkpointDatabasePath,
    "report.factLocators.checkpointDatabasePath",
  );
  const frozenCheckpointSnapshotPublication = decodeCheckpointSnapshotPublication(
    locatorsValue.frozenCheckpointSnapshotPublication,
    "report.factLocators.frozenCheckpointSnapshotPublication",
  );
  const observerStoreDirectory = absolutePath(locatorsValue.observerStoreDirectory, "report.factLocators.observerStoreDirectory");
  const authorizationLedgerPath = absolutePath(locatorsValue.authorizationLedgerPath, "report.factLocators.authorizationLedgerPath");
  const logWindowValue = ownRecord(locatorsValue.logWindow, "report.factLocators.logWindow");
  assertExactKeys(logWindowValue, [
    "path", "device", "inode", "startInclusive", "endExclusive", "contentSha256",
  ], "report.factLocators.logWindow");
  const logWindow = Object.freeze({
    path: absolutePath(logWindowValue.path, "report.factLocators.logWindow.path"),
    device: assertDecimalString(logWindowValue.device, "report.factLocators.logWindow.device"),
    inode: assertDecimalString(logWindowValue.inode, "report.factLocators.logWindow.inode"),
    startInclusive: assertDecimalString(logWindowValue.startInclusive, "report.factLocators.logWindow.startInclusive"),
    endExclusive: assertDecimalString(logWindowValue.endExclusive, "report.factLocators.logWindow.endExclusive"),
    contentSha256: hash(logWindowValue.contentSha256, "report.factLocators.logWindow.contentSha256"),
  });
  if (BigInt(logWindow.endExclusive) <= BigInt(logWindow.startInclusive)) {
    throw new TypeError("report fact log window is empty");
  }
  const factBinding = Object.freeze({
    processImportReceiptId: hash(factBindingValue.processImportReceiptId, "report.factBinding.processImportReceiptId"),
    databaseContentSha256: hash(factBindingValue.databaseContentSha256, "report.factBinding.databaseContentSha256"),
    terminalSnapshotTrustRoot: factBindingValue.terminalSnapshotTrustRoot === null
      ? null
      : hash(factBindingValue.terminalSnapshotTrustRoot, "report.factBinding.terminalSnapshotTrustRoot"),
  });

  const factIndexValue = ownRecord(report.factIndex, "report.factIndex");
  const terminalValue = ownRecord(factIndexValue.terminalPhase, "report.factIndex.terminalPhase");
  const storeValue = ownRecord(terminalValue.observerContentStore, "report.factIndex.terminalPhase.observerContentStore");
  const indexValue = ownRecord(terminalValue.index, "report.factIndex.terminalPhase.index");
  assertExactKeys(terminalValue, [
    "finalDurableWindowId", "terminalLocatorDirectory", "observerContentStore", "index", "locator",
    "manifest", "fullFamilyTerminalBinding", "fullGraphCoarseSweep", "sixStepPhysicalStatus",
    "sixStepPhysicalReason",
  ], "report.factIndex.terminalPhase");
  const locatorValue = ownRecord(terminalValue.locator, "report.factIndex.terminalPhase.locator");
  const manifestValue = ownRecord(terminalValue.manifest, "report.factIndex.terminalPhase.manifest");
  const terminalBindingValue = ownRecord(
    terminalValue.fullFamilyTerminalBinding,
    "report.factIndex.terminalPhase.fullFamilyTerminalBinding",
  );
  assertExactKeys(locatorValue, ["locatorRoot", "artifactRefId", "contentSha256"], "report.factIndex.terminalPhase.locator");
  assertExactKeys(manifestValue, ["manifestRoot", "artifactRefId", "contentSha256"], "report.factIndex.terminalPhase.manifest");
  assertExactKeys(terminalBindingValue, ["artifactRefId", "contentSha256"], "report.factIndex.terminalPhase.fullFamilyTerminalBinding");
  const sweepValue = ownRecord(terminalValue.fullGraphCoarseSweep, "report.factIndex.terminalPhase.fullGraphCoarseSweep");
  const familyCounts = sweepValue.familyTransitionCounts;
  if (!Array.isArray(familyCounts)) throw new TypeError("report.factIndex.terminalPhase.fullGraphCoarseSweep.familyTransitionCounts must be an array");
  const fullGraphCoarseSweep = Object.freeze({
    artifactRefId: hash(sweepValue.artifactRefId, "report.factIndex.terminalPhase.fullGraphCoarseSweep.artifactRefId"),
    contentSha256: hash(sweepValue.contentSha256, "report.factIndex.terminalPhase.fullGraphCoarseSweep.contentSha256"),
    sweepRoot: hash(sweepValue.sweepRoot, "report.factIndex.terminalPhase.fullGraphCoarseSweep.sweepRoot"),
    expectedTransitionCount: assertDecimalString(sweepValue.expectedTransitionCount, "report.factIndex.terminalPhase.fullGraphCoarseSweep.expectedTransitionCount"),
    expectedTransitionRoot: hash(sweepValue.expectedTransitionRoot, "report.factIndex.terminalPhase.fullGraphCoarseSweep.expectedTransitionRoot"),
    observedTransitionCount: assertDecimalString(sweepValue.observedTransitionCount, "report.factIndex.terminalPhase.fullGraphCoarseSweep.observedTransitionCount"),
    observedTransitionRoot: hash(sweepValue.observedTransitionRoot, "report.factIndex.terminalPhase.fullGraphCoarseSweep.observedTransitionRoot"),
    missingTransitionCount: assertDecimalString(sweepValue.missingTransitionCount, "report.factIndex.terminalPhase.fullGraphCoarseSweep.missingTransitionCount"),
    missingTransitionRoot: hash(sweepValue.missingTransitionRoot, "report.factIndex.terminalPhase.fullGraphCoarseSweep.missingTransitionRoot"),
    familyTransitionCounts: familyCounts as unknown as FullGraphCoarseSweepV1["familyTransitionCounts"],
  });
  if (terminalValue.sixStepPhysicalStatus !== "observed"
    && terminalValue.sixStepPhysicalStatus !== "invalid") {
    throw new TypeError("report.factIndex.terminalPhase.sixStepPhysicalStatus is invalid");
  }
  const sixStepPhysicalStatus = terminalValue.sixStepPhysicalStatus;
  const sixStepPhysicalReason = terminalValue.sixStepPhysicalReason === null
    ? null
    : nonEmptyString(terminalValue.sixStepPhysicalReason, "report.factIndex.terminalPhase.sixStepPhysicalReason");
  const terminalPhase = Object.freeze({
    finalDurableWindowId: hash(terminalValue.finalDurableWindowId, "report.factIndex.terminalPhase.finalDurableWindowId"),
    terminalLocatorDirectory: absolutePath(
      terminalValue.terminalLocatorDirectory,
      "report.factIndex.terminalPhase.terminalLocatorDirectory",
    ),
    observerContentStore: Object.freeze({
      directory: absolutePath(storeValue.directory, "report.factIndex.terminalPhase.observerContentStore.directory"),
      device: assertDecimalString(storeValue.device, "report.factIndex.terminalPhase.observerContentStore.device"),
      inode: assertDecimalString(storeValue.inode, "report.factIndex.terminalPhase.observerContentStore.inode"),
      storeIdentityHash: hash(storeValue.storeIdentityHash, "report.factIndex.terminalPhase.observerContentStore.storeIdentityHash"),
    }),
    index: Object.freeze({
      path: absolutePath(indexValue.path, "report.factIndex.terminalPhase.index.path"),
      device: assertDecimalString(indexValue.device, "report.factIndex.terminalPhase.index.device"),
      inode: assertDecimalString(indexValue.inode, "report.factIndex.terminalPhase.index.inode"),
      contentSha256: hash(indexValue.contentSha256, "report.factIndex.terminalPhase.index.contentSha256"),
      byteLength: assertDecimalString(indexValue.byteLength, "report.factIndex.terminalPhase.index.byteLength"),
      indexRoot: hash(indexValue.indexRoot, "report.factIndex.terminalPhase.index.indexRoot"),
    }),
    locator: Object.freeze({
      locatorRoot: hash(locatorValue.locatorRoot, "report.factIndex.terminalPhase.locator.locatorRoot"),
      artifactRefId: hash(locatorValue.artifactRefId, "report.factIndex.terminalPhase.locator.artifactRefId"),
      contentSha256: hash(locatorValue.contentSha256, "report.factIndex.terminalPhase.locator.contentSha256"),
    }),
    manifest: Object.freeze({
      manifestRoot: hash(manifestValue.manifestRoot, "report.factIndex.terminalPhase.manifest.manifestRoot"),
      artifactRefId: hash(manifestValue.artifactRefId, "report.factIndex.terminalPhase.manifest.artifactRefId"),
      contentSha256: hash(manifestValue.contentSha256, "report.factIndex.terminalPhase.manifest.contentSha256"),
    }),
    fullFamilyTerminalBinding: Object.freeze({
      artifactRefId: hash(terminalBindingValue.artifactRefId, "report.factIndex.terminalPhase.fullFamilyTerminalBinding.artifactRefId"),
      contentSha256: hash(terminalBindingValue.contentSha256, "report.factIndex.terminalPhase.fullFamilyTerminalBinding.contentSha256"),
    }),
    fullGraphCoarseSweep,
    sixStepPhysicalStatus,
    sixStepPhysicalReason,
  });

  const queryValue = ownRecord(factIndexValue.processEvidenceQuery, "report.factIndex.processEvidenceQuery");
  const routeQuery = ownRecord(queryValue.routeDenominator, "report.factIndex.processEvidenceQuery.routeDenominator");
  const candidateQuery = ownRecord(queryValue.candidateSet, "report.factIndex.processEvidenceQuery.candidateSet");
  const joins = ownRecord(queryValue.joins, "report.factIndex.processEvidenceQuery.joins");
  const exactAdmission = ownRecord(queryValue.exactAdmission, "report.factIndex.processEvidenceQuery.exactAdmission");
  const databasePath = absolutePath(queryValue.databasePath, "report.factIndex.processEvidenceQuery.databasePath");
  exactLiteral(routeQuery.namespace, "searcher-production-evidence/route-denominators/v1", "report.factIndex.processEvidenceQuery.routeDenominator.namespace");
  exactLiteral(routeQuery.eventType, "route-denominator", "report.factIndex.processEvidenceQuery.routeDenominator.eventType");
  exactLiteral(routeQuery.accountingEntriesPath, "payload.accounting.entries", "report.factIndex.processEvidenceQuery.routeDenominator.accountingEntriesPath");
  exactLiteral(candidateQuery.namespace, "searcher-production-evidence/candidate-sets/v1", "report.factIndex.processEvidenceQuery.candidateSet.namespace");
  exactLiteral(candidateQuery.eventType, "candidate-set", "report.factIndex.processEvidenceQuery.candidateSet.eventType");
  exactLiteral(candidateQuery.laneDenominatorsPath, "payload.laneDenominators", "report.factIndex.processEvidenceQuery.candidateSet.laneDenominatorsPath");
  exactLiteral(candidateQuery.terminalObservationsPath, "payload.candidateTerminalObservations", "report.factIndex.processEvidenceQuery.candidateSet.terminalObservationsPath");
  if (!sameCanonical(joins, EXPECTED_JOIN_CONTRACT_V1)) {
    throw new TypeError("report.factIndex.processEvidenceQuery.joins mismatch");
  }
  exactLiteral(exactAdmission.sourcePath, "payload.accounting.entries[].disposition", "report.factIndex.processEvidenceQuery.exactAdmission.sourcePath");
  exactLiteral(exactAdmission.disposition, "selected", "report.factIndex.processEvidenceQuery.exactAdmission.disposition");
  if (databasePath !== processEvidenceDatabasePath || databasePath !== processEvidenceDatabase.path) {
    throw new TypeError("report process evidence database locators disagree");
  }
  if (factBinding.databaseContentSha256 !== processEvidenceDatabase.contentSha256) {
    throw new TypeError("report process evidence database content binding mismatch");
  }
  const expectedIndexPath = join(
    terminalPhase.terminalLocatorDirectory,
    `${terminalPhase.finalDurableWindowId.slice(2)}.json`,
  );
  if (terminalPhase.index.path !== expectedIndexPath) {
    throw new TypeError("report terminal-phase index path mismatch");
  }
  return Object.freeze({
    release,
    physicalProcess,
    factBinding,
    factLocators: Object.freeze({
      processEvidenceDatabasePath,
      checkpointDatabasePath,
      frozenCheckpointSnapshotPublication,
      observerStoreDirectory,
      authorizationLedgerPath,
      processEvidenceDatabase,
      logWindow,
    }),
    factIndex: Object.freeze({
      terminalPhase,
      processEvidenceQuery: Object.freeze({
        databasePath,
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
        joins: EXPECTED_JOIN_CONTRACT_V1,
        exactAdmission: Object.freeze({
          sourcePath: "payload.accounting.entries[].disposition" as const,
          disposition: "selected" as const,
        }),
      }),
    }),
    nominationQualificationReuse,
    judgmentRoot,
  });
}

function indexedContentObjectByteLength(
  value: unknown,
  expected: Readonly<{ readonly artifactRefId: Hash; readonly contentSha256: Hash }>,
  storeIdentityHash: Hash,
  path: string,
): string {
  const artifact = ownRecord(value, path);
  const ref = ownRecord(artifact.ref, `${path}.ref`);
  const locator = ownRecord(ref.locator, `${path}.ref.locator`);
  const immutableLocator = ownRecord(ref.immutableMirrorLocator, `${path}.ref.immutableMirrorLocator`);
  const byteLength = assertDecimalString(ref.byteLength, `${path}.ref.byteLength`);
  if (hash(artifact.contentSha256, `${path}.contentSha256`) !== expected.contentSha256
    || hash(ref.contentSha256, `${path}.ref.contentSha256`) !== expected.contentSha256
    || hash(ref.artifactRefId, `${path}.ref.artifactRefId`) !== expected.artifactRefId
    || locator.kind !== "content-object"
    || immutableLocator.kind !== "content-object"
    || hash(locator.storeIdentityHash, `${path}.ref.locator.storeIdentityHash`) !== storeIdentityHash
    || hash(immutableLocator.storeIdentityHash, `${path}.ref.immutableMirrorLocator.storeIdentityHash`) !== storeIdentityHash
    || hash(locator.objectKey, `${path}.ref.locator.objectKey`) !== expected.contentSha256
    || hash(immutableLocator.objectKey, `${path}.ref.immutableMirrorLocator.objectKey`) !== expected.contentSha256) {
    throw new TypeError(`${path} content-object binding mismatch`);
  }
  return byteLength;
}

function decodeIndexAndBind(report: AdvisoryReportV1): Readonly<{
  readonly sweepByteLength: string;
  readonly terminalBindingByteLength: string;
}> {
  const indexBytes = readPhysicalFile(report.factIndex.terminalPhase.index.path, {
    device: report.factIndex.terminalPhase.index.device,
    inode: report.factIndex.terminalPhase.index.inode,
    contentSha256: report.factIndex.terminalPhase.index.contentSha256,
    byteLength: report.factIndex.terminalPhase.index.byteLength,
  });
  const index = ownRecord(decodeCanonicalBytes(indexBytes), "terminalPhaseIndex");
  const indexRoot = hash(index.indexRoot, "terminalPhaseIndex.indexRoot");
  const { indexRoot: _indexRoot, ...body } = index;
  if (indexRoot !== report.factIndex.terminalPhase.index.indexRoot
    || indexRoot !== hashDomain("aloha/production-terminal-phase-locator-index/v1", body as CanonicalJson)) {
    throw new TypeError("terminal-phase index root mismatch");
  }
  if (hash(index.finalDurableWindowId, "terminalPhaseIndex.finalDurableWindowId") !== report.factIndex.terminalPhase.finalDurableWindowId) {
    throw new TypeError("terminal-phase index window mismatch");
  }
  const sweepByteLength = indexedContentObjectByteLength(
    index.fullGraphCoarseSweepArtifact,
    report.factIndex.terminalPhase.fullGraphCoarseSweep,
    report.factIndex.terminalPhase.observerContentStore.storeIdentityHash,
    "terminalPhaseIndex.fullGraphCoarseSweepArtifact",
  );
  const terminalBindingByteLength = indexedContentObjectByteLength(
    index.fullFamilyTerminalBindingArtifact,
    report.factIndex.terminalPhase.fullFamilyTerminalBinding,
    report.factIndex.terminalPhase.observerContentStore.storeIdentityHash,
    "terminalPhaseIndex.fullFamilyTerminalBindingArtifact",
  );
  return Object.freeze({ sweepByteLength, terminalBindingByteLength });
}

function readSweep(report: AdvisoryReportV1, sweepByteLength: string): FullGraphCoarseSweepV1 {
  const store = report.factIndex.terminalPhase.observerContentStore;
  const directoryDescriptor = openSync(store.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(directoryDescriptor, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || before.dev.toString() !== store.device || before.ino.toString() !== store.inode) {
      throw new TypeError("observer content store physical identity changed");
    }
    const markerPath = join(store.directory, ".aloha-observer-store-identity-v1");
    const marker = readPhysicalFile(markerPath, { requireWriteOnce: true });
    if (Buffer.from(marker).toString("utf8") !== `${store.storeIdentityHash}\n`) {
      throw new TypeError("observer content store identity marker mismatch");
    }
    const contentHash = report.factIndex.terminalPhase.fullGraphCoarseSweep.contentSha256;
    const objectName = contentHash.slice(2);
    const objectPath = join(store.directory, objectName);
    if (dirname(objectPath) !== store.directory || basename(objectPath) !== objectName) {
      throw new TypeError("Full-Graph object escaped observer content store");
    }
    const bytes = readPhysicalFile(objectPath, {
      contentSha256: contentHash,
      byteLength: sweepByteLength,
      requireWriteOnce: true,
    });
    const manifest = decodeFullGraphCoarseSweepManifestV1(bytes);
    const sweep = decodeFullGraphCoarseSweepV1(bytes, ref => {
      const chunkName = ref.contentSha256.slice(2);
      const chunkPath = join(store.directory, chunkName);
      if (dirname(chunkPath) !== store.directory || basename(chunkPath) !== chunkName) {
        throw new TypeError("Full-Graph chunk escaped observer content store");
      }
      const bytes = readPhysicalFile(chunkPath, {
        contentSha256: ref.contentSha256,
        requireWriteOnce: true,
      });
      return bytes;
    });
    if (manifest.sweepRoot !== sweep.sweepRoot) throw new TypeError("Full-Graph manifest/materialized root mismatch");
    validateMaterializedFullGraphSweepV1(sweep);
    const after = fstatSync(directoryDescriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new TypeError("observer content store changed during Full-Graph read");
    }
    const currentDirectoryDescriptor = openSync(
      store.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const current = fstatSync(currentDirectoryDescriptor, { bigint: true });
      if (current.dev !== after.dev || current.ino !== after.ino) {
        throw new TypeError("observer content store locator changed during Full-Graph read");
      }
    } finally {
      closeSync(currentDirectoryDescriptor);
    }
    const index = report.factIndex.terminalPhase.fullGraphCoarseSweep;
    if (sweep.sweepRoot !== index.sweepRoot
      || sweep.expectedTransitionCount !== index.expectedTransitionCount
      || sweep.expectedTransitionRoot !== index.expectedTransitionRoot
      || sweep.observedTransitionCount !== index.observedTransitionCount
      || sweep.observedTransitionRoot !== index.observedTransitionRoot
      || sweep.missingTransitionCount !== index.missingTransitionCount
      || sweep.missingTransitionRoot !== index.missingTransitionRoot
      || !sameCanonical(sweep.familyTransitionCounts, index.familyTransitionCounts)
      || sweep.binding.runtimeBindingId !== report.release.runtimeBindingId
      || sweep.binding.releaseProvenanceHash !== report.release.releaseProvenanceHash
      || sweep.binding.candidateReleaseCommit !== report.release.candidateReleaseCommit) {
      throw new TypeError("Full-Graph sweep/report fact binding mismatch");
    }
    return sweep;
  } finally {
    closeSync(directoryDescriptor);
  }
}

const FULL_FAMILY_TERMINAL_BINDING_KEYS = Object.freeze([
  "schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash",
  "finalDurableWindowId", "producerTerminalId", "producerHeadFactsRoot", "producerTerminalBindingRoot",
  "laneTerminalSetRoot", "searchTerminalHash", "terminalKind", "terminalLineageHash",
  "readyRecordHash", "generationId", "graphRoot", "generatedRuntime", "readyCutoff", "actualCurrentSource",
  "nativeAuditManifest", "bindingRoot",
] as const);

function readFullFamilyTerminalBinding(
  report: AdvisoryReportV1,
  byteLength: string,
): FullFamilyTerminalBindingObservationV1 {
  const store = report.factIndex.terminalPhase.observerContentStore;
  const directoryDescriptor = openSync(store.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(directoryDescriptor, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || before.dev.toString() !== store.device || before.ino.toString() !== store.inode) {
      throw new TypeError("observer content store physical identity changed");
    }
    const marker = readPhysicalFile(join(store.directory, ".aloha-observer-store-identity-v1"), { requireWriteOnce: true });
    if (Buffer.from(marker).toString("utf8") !== `${store.storeIdentityHash}\n`) {
      throw new TypeError("observer content store identity marker mismatch");
    }
    const contentHash = report.factIndex.terminalPhase.fullFamilyTerminalBinding.contentSha256;
    const objectName = contentHash.slice(2);
    const objectPath = join(store.directory, objectName);
    if (dirname(objectPath) !== store.directory || basename(objectPath) !== objectName) {
      throw new TypeError("Full-Family terminal binding escaped observer content store");
    }
    const value = ownRecord(decodeCanonicalBytes(readPhysicalFile(objectPath, {
      contentSha256: contentHash,
      byteLength,
      requireWriteOnce: true,
    })), "fullFamilyTerminalBinding");
    assertExactKeys(value, FULL_FAMILY_TERMINAL_BINDING_KEYS, "fullFamilyTerminalBinding");
    exactLiteral(value.schemaVersion, 1, "fullFamilyTerminalBinding.schemaVersion");
    exactLiteral(value.kind, "aloha.runtime-release-full-family-terminal-binding-v1", "fullFamilyTerminalBinding.kind");
    const bindingRoot = hash(value.bindingRoot, "fullFamilyTerminalBinding.bindingRoot");
    const { bindingRoot: _bindingRoot, ...bindingPayload } = value;
    if (bindingRoot !== hashDomain("aloha/runtime-release-full-family-terminal-binding/v1", bindingPayload as CanonicalJson)) {
      throw new TypeError("Full-Family terminal binding root mismatch");
    }
    const runtimeBindingId = hash(value.runtimeBindingId, "fullFamilyTerminalBinding.runtimeBindingId");
    const candidateReleaseCommit = gitSha40Schema.decode(value.candidateReleaseCommit, "fullFamilyTerminalBinding.candidateReleaseCommit");
    const releaseProvenanceHash = hash(value.releaseProvenanceHash, "fullFamilyTerminalBinding.releaseProvenanceHash");
    const finalDurableWindowId = hash(value.finalDurableWindowId, "fullFamilyTerminalBinding.finalDurableWindowId");
    for (const field of [
      "producerTerminalId", "producerHeadFactsRoot", "producerTerminalBindingRoot", "laneTerminalSetRoot",
      "searchTerminalHash", "terminalLineageHash", "readyRecordHash", "graphRoot",
    ] as const) hash(value[field], `fullFamilyTerminalBinding.${field}`);
    const terminalKind = value.terminalKind;
    if (terminalKind !== "unsigned-dry-run" && terminalKind !== "route-set-terminal") {
      throw new TypeError("Full-Family terminal binding terminalKind mismatch");
    }
    nonEmptyString(value.generationId, "fullFamilyTerminalBinding.generationId");
    currentSourceIdentity(value.readyCutoff, "fullFamilyTerminalBinding.readyCutoff");
    currentSourceIdentity(value.actualCurrentSource, "fullFamilyTerminalBinding.actualCurrentSource");
    const generatedRuntime = ownRecord(value.generatedRuntime, "fullFamilyTerminalBinding.generatedRuntime");
    assertExactKeys(generatedRuntime, [
      "releaseIntentRoot", "definitionCatalogRoot", "runtimeDescriptorRoot", "families",
    ], "fullFamilyTerminalBinding.generatedRuntime");
    hash(generatedRuntime.releaseIntentRoot, "fullFamilyTerminalBinding.generatedRuntime.releaseIntentRoot");
    hash(generatedRuntime.definitionCatalogRoot, "fullFamilyTerminalBinding.generatedRuntime.definitionCatalogRoot");
    hash(generatedRuntime.runtimeDescriptorRoot, "fullFamilyTerminalBinding.generatedRuntime.runtimeDescriptorRoot");
    if (!Array.isArray(generatedRuntime.families) || generatedRuntime.families.length === 0) {
      throw new TypeError("Full-Family terminal binding generated runtime Family denominator is empty");
    }
    for (const [index, rawFamily] of generatedRuntime.families.entries()) {
      const family = ownRecord(rawFamily, `fullFamilyTerminalBinding.generatedRuntime.families[${index}]`);
      assertExactKeys(family, ["familyId", "familyDefinitionHash", "sourcePlanRoot", "sourcePlanRefs"], `fullFamilyTerminalBinding.generatedRuntime.families[${index}]`);
      nonEmptyString(family.familyId, `fullFamilyTerminalBinding.generatedRuntime.families[${index}].familyId`);
      hash(family.familyDefinitionHash, `fullFamilyTerminalBinding.generatedRuntime.families[${index}].familyDefinitionHash`);
      hash(family.sourcePlanRoot, `fullFamilyTerminalBinding.generatedRuntime.families[${index}].sourcePlanRoot`);
      if (!Array.isArray(family.sourcePlanRefs)) throw new TypeError("Full-Family terminal binding sourcePlanRefs must be an array");
    }
    const manifestBytes = encodeCanonicalBytes(value.nativeAuditManifest as CanonicalJson);
    const manifest = decodeNativeFullFamilyAuditManifestV1(manifestBytes);
    const audit = decodeNativeFullFamilyAuditV1(manifestBytes, ref => {
      const chunkName = ref.contentSha256.slice(2);
      const chunkPath = join(store.directory, chunkName);
      if (dirname(chunkPath) !== store.directory || basename(chunkPath) !== chunkName) {
        throw new TypeError("native Full-Family audit chunk escaped observer content store");
      }
      return readPhysicalFile(chunkPath, {
        contentSha256: ref.contentSha256,
        requireWriteOnce: true,
      });
    });
    validateNativeFullFamilyAuditWireV1(audit);
    if (audit.auditRoot !== manifest.auditRoot
      || audit.binding.readyRecordHash !== value.readyRecordHash
      || audit.binding.generationId !== value.generationId
      || audit.binding.graphRoot !== value.graphRoot
      || audit.binding.releaseProvenanceHash !== value.releaseProvenanceHash
      || !sameCanonical(audit.binding.readyCutoff, value.readyCutoff)
      || !sameCanonical(audit.binding.actualCurrentSource, value.actualCurrentSource)) {
      throw new TypeError("Full-Family terminal/native-audit binding splice");
    }
    if (runtimeBindingId !== report.release.runtimeBindingId
      || candidateReleaseCommit !== report.release.candidateReleaseCommit
      || releaseProvenanceHash !== report.release.releaseProvenanceHash
      || finalDurableWindowId !== report.factIndex.terminalPhase.finalDurableWindowId) {
      throw new TypeError("Full-Family terminal binding/report splice");
    }
    const after = fstatSync(directoryDescriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new TypeError("observer content store changed during Full-Family terminal binding read");
    }
    const currentDirectoryDescriptor = openSync(
      store.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const current = fstatSync(currentDirectoryDescriptor, { bigint: true });
      if (current.dev !== after.dev || current.ino !== after.ino) {
        throw new TypeError("observer content store locator changed during native Full-Family read");
      }
    } finally {
      closeSync(currentDirectoryDescriptor);
    }
    return Object.freeze({
      bindingRoot,
      terminalKind,
      terminalLineageHash: hash(value.terminalLineageHash, "fullFamilyTerminalBinding.terminalLineageHash"),
      audit,
    });
  } finally {
    closeSync(directoryDescriptor);
  }
}

function lane(value: unknown, path: string): LaneV1 {
  if (value !== "blockscan" && value !== "backrun") throw new TypeError(`${path} is invalid`);
  return value;
}

function routePayload(event: ObservedProductionEventV1): RoutePayloadV1 {
  const payload = ownRecord(event.payload, `event[${event.sequence}].payload`);
  const common = {
    admissionId: hash(payload.admissionId, "route.admissionId"),
    headFactsRoot: hash(payload.headFactsRoot, "route.headFactsRoot"),
    headHash: hash(payload.headHash, "route.headHash"),
    lane: lane(payload.lane, "route.lane"),
    correlationId: hash(payload.correlationId, "route.correlationId"),
    coverageRoot: hash(payload.coverageRoot, "route.coverageRoot"),
  };
  if (payload.denominatorKind === "no-input") return payload as unknown as NoInputRoutePayloadV1;
  if (payload.denominatorKind !== "accounted") throw new TypeError("route denominator kind is invalid after observation");
  const accounting = ownRecord(payload.accounting, "route.accounting");
  if (!Array.isArray(accounting.entries)) throw new TypeError("route.accounting.entries is missing after observation");
  void common;
  return payload as unknown as AccountedRoutePayloadV1;
}

function candidatePayload(event: ObservedProductionEventV1): CandidateSetPayloadV1 {
  const payload = ownRecord(event.payload, `candidateSet[${event.sequence}].payload`);
  hash(payload.admissionId, "candidateSet.admissionId");
  hash(payload.headFactsRoot, "candidateSet.headFactsRoot");
  hash(payload.headHash, "candidateSet.headHash");
  if (!Array.isArray(payload.laneDenominators) || !Array.isArray(payload.candidateTerminalObservations)) {
    throw new TypeError("candidate-set nested denominators/terminal observations are missing after observation");
  }
  return payload as unknown as CandidateSetPayloadV1;
}

function difference(field: string, left: CanonicalJson | undefined, right: CanonicalJson | undefined): CanonicalJson | null {
  if (left !== undefined && right !== undefined && sameCanonical(left, right)) return null;
  return Object.freeze({ field, route: left ?? null, candidate: right ?? null });
}

function compareFields(
  left: Readonly<Record<string, CanonicalJson>> | null,
  right: Readonly<Record<string, CanonicalJson>> | null,
  fields: readonly string[],
): readonly CanonicalJson[] {
  return Object.freeze(fields.flatMap(field => {
    const observed = difference(field, left?.[field], right?.[field]);
    return observed === null ? [] : [observed];
  }));
}

type FactSourceClassificationV1 =
  | "root-owned-physical-observation"
  | "raw-sqlite-observation"
  | "self-consistent-advisory-claim"
  | "invalid-basis";

function record(
  kind: string,
  body: Readonly<Record<string, CanonicalJson>>,
  sourceClassification: FactSourceClassificationV1 = "raw-sqlite-observation",
): PreReleaseFactLogRecordV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind,
    advisoryOnly: true,
    sourceClassification,
    ...body,
  });
}

function eventIdentity(event: ObservedProductionEventV1): CanonicalJson {
  return Object.freeze({ namespace: event.namespace, sequence: event.sequence, eventId: event.eventId });
}

function observedOrderedRoot(domain: string, values: readonly CanonicalJson[]): Hash {
  return hashCanonicalPartition(domain, values, 128);
}

function materialLocator(
  report: AdvisoryReportV1,
  event: ObservedProductionEventV1,
  materialKind: "route-accounting-entries" | "candidate-terminal-observations",
): CanonicalJson {
  return Object.freeze({
    databasePath: report.factIndex.processEvidenceQuery.databasePath,
    event: eventIdentity(event),
    materialKind,
  });
}

function headIdentity(value: Readonly<{ readonly admissionId: Hash; readonly headFactsRoot: Hash; readonly headHash: Hash }>): CanonicalJson {
  return Object.freeze({
    admissionId: value.admissionId,
    headFactsRoot: value.headFactsRoot,
    headHash: value.headHash,
  });
}

function laneIdentity(value: Readonly<{
  readonly lane: LaneV1;
  readonly correlationId: Hash;
  readonly coverageRoot: Hash;
  readonly accountingRoot: Hash | null;
}>): CanonicalJson {
  return Object.freeze({
    lane: value.lane,
    correlationId: value.correlationId,
    coverageRoot: value.coverageRoot,
    accountingRoot: value.accountingRoot,
  });
}

const SELF_CONSISTENT_ADVISORY_CLAIM = "self-consistent-advisory-claim" as const;

/** Reuse output proves only internal report consistency; it carries no signature or external fact authority. */
function appendNominationQualificationReuseClaims(
  records: PreReleaseFactLogRecordV1[],
  report: AdvisoryReportV1,
): void {
  const observation = report.nominationQualificationReuse;
  if (observation.status === "unavailable") {
    records.push(record("aloha.pre-release-nomination-qualification-reuse-claim-v1", {
      producerStatus: observation.status,
      producerCode: observation.code,
      advisoryOnly: true,
      sourceClassification: SELF_CONSISTENT_ADVISORY_CLAIM,
      advisoryJudgmentRoot: report.judgmentRoot,
    }));
    return;
  }
  const pre = observation.preSignReport;
  const post = observation.postSignReport;
  records.push(record("aloha.pre-release-nomination-qualification-reuse-claim-v1", {
    producerStatus: observation.status,
    advisoryOnly: true,
    sourceClassification: SELF_CONSISTENT_ADVISORY_CLAIM,
    advisoryJudgmentRoot: report.judgmentRoot,
    preSignReportRoot: pre.reportRoot,
    postSignReportRoot: post.reportRoot,
    priorDeploymentFactId: pre.priorDeploymentFactId,
    priorRuntimeBindingId: pre.priorRuntimeBindingId,
    currentDeploymentFactId: post.currentDeploymentFactId,
    currentRuntimeBindingId: post.currentRuntimeBindingId,
    priorSnapshotRoot: pre.priorSnapshotRoot,
    currentSnapshotRoot: pre.currentSnapshotRoot,
    currentFamilyProposalOwnershipRoot: pre.currentFamilyProposalOwnershipRoot,
    currentSemanticLedgerHash: pre.currentSemanticLedgerHash,
    currentSemanticOutputRoot: pre.currentSemanticOutputRoot,
    currentBoundaryVerificationReceiptRoot: pre.currentBoundaryVerificationReceiptRoot,
    reusedFamilyCount: String(pre.reusedFamilies.length),
    requalificationFamilyCount: String(pre.requalificationDenominator.length),
    verifiedQualificationEntryCount: String(post.verifiedQualificationEntryCount),
  }));
  for (const [familyIndex, family] of pre.reusedFamilies.entries()) {
    records.push(record("aloha.pre-release-nomination-qualification-reused-family-claim-v1", {
      advisoryOnly: true,
      sourceClassification: SELF_CONSISTENT_ADVISORY_CLAIM,
      preSignReportRoot: pre.reportRoot,
      familyIndex: String(familyIndex),
      familyId: family.familyId,
      artifactId: family.artifactId,
      nominationProposalLeafDigests: family.nominationProposalLeafDigests,
      nominationQualificationEntryCount: String(family.nominationQualificationEntries.length),
    }));
    for (const [entryIndex, entry] of family.nominationQualificationEntries.entries()) {
      records.push(record("aloha.pre-release-nomination-qualification-reused-entry-claim-v1", {
        advisoryOnly: true,
        sourceClassification: SELF_CONSISTENT_ADVISORY_CLAIM,
        preSignReportRoot: pre.reportRoot,
        familyIndex: String(familyIndex),
        entryIndex: String(entryIndex),
        familyId: family.familyId,
        artifactId: family.artifactId,
        proposalLeafDigest: entry.proposalLeafDigest,
        entry,
      }));
    }
  }
  for (const [familyIndex, family] of pre.requalificationDenominator.entries()) {
    records.push(record("aloha.pre-release-nomination-requalification-denominator-claim-v1", {
      advisoryOnly: true,
      sourceClassification: SELF_CONSISTENT_ADVISORY_CLAIM,
      preSignReportRoot: pre.reportRoot,
      familyIndex: String(familyIndex),
      familyId: family.familyId,
      artifactId: family.artifactId,
      nominationProposalLeafDigests: family.nominationProposalLeafDigests,
      reason: family.reason,
    }));
  }
}

interface CurrentSourceIdentityV1 extends Readonly<Record<string, CanonicalJson>> {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

interface ActiveEligibleAdmissionV1 {
  readonly admissionId: Hash;
  readonly ordinal: string;
  readonly source: CurrentSourceIdentityV1;
}

function currentSourceIdentity(value: unknown, path: string): CurrentSourceIdentityV1 {
  const source = ownRecord(value, path);
  return Object.freeze({
    chainId: assertDecimalString(source.chainId, `${path}.chainId`),
    number: assertDecimalString(source.number, `${path}.number`),
    hash: hash(source.hash, `${path}.hash`),
    stateRoot: hash(source.stateRoot, `${path}.stateRoot`),
  });
}

function activeEligibleAdmissions(observation: RawPerformanceObservationV1): readonly ActiveEligibleAdmissionV1[] {
  const active = new Map<string, ActiveEligibleAdmissionV1>();
  for (const event of observation.events) {
    if (event.eventType !== "eligible-head" && event.eventType !== "orphan-replacement") continue;
    const payload = ownRecord(event.payload, `activeEligible[${event.sequence}].payload`);
    const ordinal = assertDecimalString(payload.ordinal, `activeEligible[${event.sequence}].ordinal`);
    const head = ownRecord(payload.head, `activeEligible[${event.sequence}].head`);
    active.set(ordinal, Object.freeze({
      admissionId: hash(payload.admissionId, `activeEligible[${event.sequence}].admissionId`),
      ordinal,
      source: currentSourceIdentity(head, `activeEligible[${event.sequence}].head`),
    }));
  }
  return Object.freeze([...active.values()].sort((left, right) => {
    const difference = BigInt(left.ordinal) - BigInt(right.ordinal);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }));
}

function uniqueHeadCoverage(
  observation: RawPerformanceObservationV1,
  admission: ActiveEligibleAdmissionV1,
  path: string,
): ObservedProductionEventV1 {
  const matches = observation.events.filter(event => event.eventType === "head-coverage"
    && event.payload.admissionId === admission.admissionId);
  if (matches.length !== 1) throw new TypeError(`${path} does not have one exact head-coverage event`);
  const payload = ownRecord(matches[0]!.payload, `${path}.payload`);
  if (hash(payload.headHash, `${path}.headHash`) !== admission.source.hash) {
    throw new TypeError(`${path} head hash does not join its active eligible admission`);
  }
  return matches[0]!;
}

function assertCoverageSources(
  event: ObservedProductionEventV1,
  expected: CurrentSourceIdentityV1,
  path: string,
): void {
  const payload = ownRecord(event.payload, `${path}.payload`);
  if (payload.currentSourcePhysicalFacts === null) {
    throw new TypeError(`${path} current-source physical facts are absent`);
  }
  const physical = ownRecord(payload.currentSourcePhysicalFacts, `${path}.physical`);
  const logical = Array.isArray(payload.currentSourceLogicalFacts) ? payload.currentSourceLogicalFacts : [];
  const coarse = Array.isArray(payload.coarseTimingFacts) ? payload.coarseTimingFacts : [];
  if (logical.length === 0 || coarse.length === 0) {
    throw new TypeError(`${path} current-source logical/coarse facts are absent`);
  }
  const sources = [
    currentSourceIdentity(physical.source, `${path}.physical.source`),
    ...logical.map((item, index) => currentSourceIdentity(
      ownRecord(item, `${path}.logical[${index}]`).source,
      `${path}.logical[${index}].source`,
    )),
    ...coarse.map((item, index) => currentSourceIdentity(
      ownRecord(item, `${path}.coarse[${index}]`).source,
      `${path}.coarse[${index}].source`,
    )),
  ];
  if (sources.some(source => !sameCanonical(source, expected))) {
    throw new TypeError(`${path} current-source facts do not exact-join the active eligible head`);
  }
}

function assertPhysicalGraphBasis(
  report: AdvisoryReportV1,
  observation: RawPerformanceObservationV1,
  sweep: FullGraphCoarseSweepV1,
  activeGraph: ProductionActiveReadyGraphSnapshotV1,
): void {
  if (activeGraph.releaseProvenanceHash !== report.release.releaseProvenanceHash
    || sweep.binding.runtimeBindingId !== report.release.runtimeBindingId
    || sweep.binding.releaseProvenanceHash !== activeGraph.releaseProvenanceHash
    || sweep.binding.candidateReleaseCommit !== report.release.candidateReleaseCommit
    || sweep.binding.readyRecordHash !== activeGraph.readyRecordHash
    || sweep.binding.generationId !== activeGraph.generationId
    || sweep.binding.graphRoot !== activeGraph.graphRoot
    || !sameCanonical(sweep.binding.readyCutoff, activeGraph.cutoff)
    || sweep.expectedTransitionCount !== activeGraph.expectedTransitionCount
    || sweep.expectedTransitionRoot !== activeGraph.expectedTransitionRoot
    || !sameOrderedHashes(
      sweep.expectedTransitionIds,
      activeGraph.orderedTransitions.map(transition => transition.transitionId),
    )
    || !sameCanonical(
      sweep.familyTransitionCounts.map(entry => Object.freeze({
        familyId: entry.familyId,
        expectedTransitionCount: entry.expectedTransitionCount,
      })),
      activeGraph.familyTransitionCounts.map(entry => Object.freeze({
        familyId: entry.familyId,
        expectedTransitionCount: entry.transitionCount,
      })),
    )) {
    throw new TypeError("root-owned active Ready Graph/report/sweep denominator mismatch");
  }
  const recent = sweep.binding.recentObservationRange;
  if (recent.blockCount !== "50"
    || BigInt(recent.to) < BigInt(recent.from)
    || BigInt(recent.to) - BigInt(recent.from) + 1n !== 50n
    || recent.to !== sweep.binding.readyCutoff.number
    || BigInt(recent.from) + 49n !== BigInt(sweep.binding.readyCutoff.number)
    || sweep.binding.actualCurrentSource.chainId !== sweep.binding.readyCutoff.chainId
    || BigInt(sweep.binding.actualCurrentSource.number) < BigInt(sweep.binding.readyCutoff.number)) {
    throw new TypeError("50-block edge observation/current-source coarse binding mismatch");
  }
  const activeAdmissions = activeEligibleAdmissions(observation);
  const finalAdmission = activeAdmissions.find(admission => admission.ordinal === "100") ?? null;
  if (activeAdmissions.length !== 100 || finalAdmission === null
    || activeAdmissions.some((admission, index) => admission.ordinal !== String(index + 1))) {
    throw new TypeError("coarse current source lacks the active exact-100 final eligible-head denominator");
  }
  const finalCoverage = uniqueHeadCoverage(observation, finalAdmission, "currentSource.finalCoverage");
  assertCoverageSources(finalCoverage, finalAdmission.source, "currentSource.finalCoverage");
  if (!sameCanonical(currentSourceIdentity(sweep.binding.actualCurrentSource, "sweep.actualCurrentSource"), finalAdmission.source)) {
    throw new TypeError("coarse current source does not exact-join ordinal=100 final eligible-head");
  }

  const selectedPerformanceEventId = observation.sixStepWindowSelection?.selectedPerformanceEventId ?? null;
  if (selectedPerformanceEventId !== null) {
    const selectedPerformance = observation.events.find(event => event.eventId === selectedPerformanceEventId
      && event.eventType === "performance-facts-complete") ?? null;
    if (selectedPerformance === null) throw new TypeError("selected performance event is missing");
    const selectedAdmissionId = hash(selectedPerformance.payload.admissionId, "currentSource.selectedPerformance.admissionId");
    const selectedAdmission = activeAdmissions.find(admission => admission.admissionId === selectedAdmissionId) ?? null;
    if (selectedAdmission === null) throw new TypeError("selected performance event is not in the active eligible denominator");
    const selectedCoverage = uniqueHeadCoverage(observation, selectedAdmission, "currentSource.selectedCoverage");
    assertCoverageSources(selectedCoverage, selectedAdmission.source, "currentSource.selectedCoverage");
    const runtimeFacts = ownRecord(selectedPerformance.payload.runtimeFacts, "currentSource.selectedPerformance.runtimeFacts");
    const join = ownRecord(runtimeFacts.producerSchedulerJoin, "currentSource.selectedPerformance.producerSchedulerJoin");
    if (!sameCanonical(currentSourceIdentity(join.source, "currentSource.selectedPerformance.source"), selectedAdmission.source)) {
      throw new TypeError("selected performance source does not exact-join its own active eligible head");
    }
  }
  assertActiveReadyGraphCoarseSweepDenominatorV1(activeGraph, Object.freeze({
    readyRecordHash: sweep.binding.readyRecordHash,
    generationId: sweep.binding.generationId,
    graphRoot: sweep.binding.graphRoot,
    readyCutoff: sweep.binding.readyCutoff,
    expectedTransitionCount: sweep.expectedTransitionCount,
    expectedTransitionRoot: sweep.expectedTransitionRoot,
    expectedTransitionIds: sweep.expectedTransitionIds,
    familyTransitionCounts: sweep.familyTransitionCounts.map(entry => Object.freeze({
      familyId: entry.familyId,
      expectedTransitionCount: entry.expectedTransitionCount,
    })),
    entries: sweep.entries.map(entry => Object.freeze({
      transitionId: entry.transitionId,
      edge: Object.freeze({
        edgeId: entry.edge.edgeId,
        opaqueTransitionRef: entry.edge.opaqueTransitionRef,
        owningFamilyId: entry.edge.owningFamilyId,
      }),
      inputAssetRef: entry.inputAssetRef,
      inputPortRef: entry.inputPortRef,
      outputAssetRef: entry.outputAssetRef,
      outputPortRef: entry.outputPortRef,
    })),
  }));
}

function assertTerminalPhysicalBasis(
  report: AdvisoryReportV1,
  observation: RawPerformanceObservationV1,
  physical: PreReleaseBTerminalPhysicalObservationV1,
): void {
  const { observationRoot, ...body } = physical;
  if (physical.schemaVersion !== 1
    || physical.kind !== "aloha.pre-release-b-terminal-physical-observation-v1"
    || observationRoot !== hashDomain(
      "aloha/pre-release-b-terminal-physical-observation/v1",
      body as unknown as CanonicalJson,
    )) {
    throw new TypeError("root-owned terminal physical observation root mismatch");
  }
  if (physical.release.candidateReleaseCommit !== report.release.candidateReleaseCommit
    || physical.release.runtimeBindingId !== report.release.runtimeBindingId
    || physical.release.releaseProvenanceHash !== report.release.releaseProvenanceHash
    || physical.process.processImportReceiptId !== report.factBinding.processImportReceiptId
    || physical.process.processAnchorHash !== report.physicalProcess.processAnchorHash
    || physical.process.pid !== report.physicalProcess.pid
    || physical.process.processStartTicks !== report.physicalProcess.processStartTicks
    || physical.process.bootIdHash !== report.physicalProcess.bootIdHash
    || physical.process.executableHash !== report.physicalProcess.executableHash
    || !sameCanonical(physical.logWindow, report.factLocators.logWindow)) {
    throw new TypeError("root-owned terminal physical release/process/log splice");
  }
  const publication = physical.processEvidence.publication;
  const database = report.factLocators.processEvidenceDatabase;
  if (publication.snapshotPath !== report.factLocators.processEvidenceDatabasePath
    || publication.snapshotPath !== report.factIndex.processEvidenceQuery.databasePath
    || publication.snapshotPath !== database.path
    || publication.device !== database.device
    || publication.inode !== database.inode
    || publication.contentSha256 !== database.contentSha256
    || physical.processEvidence.databaseSha256Before !== database.contentSha256
    || physical.processEvidence.databaseSha256After !== database.contentSha256
    || physical.processEvidence.databaseSha256Before !== observation.databaseSha256Before
    || physical.processEvidence.databaseSha256After !== observation.databaseSha256After
    || physical.processEvidence.storageSetRootBefore !== observation.storageSetRootBefore
    || physical.processEvidence.storageSetRootAfter !== observation.storageSetRootAfter
    || physical.processEvidence.rawRowRoot !== observation.rawRowRoot
    || physical.processEvidence.eventRoot !== observation.eventRoot) {
    throw new TypeError("root-owned terminal physical SQLite observation splice");
  }
  const terminal = physical.terminal;
  if (terminal.snapshotTrustRoot !== report.factBinding.terminalSnapshotTrustRoot
    || terminal.finalDurableWindowId !== report.factIndex.terminalPhase.finalDurableWindowId
    || !sameCanonical(terminal.factIndex, report.factIndex)
    || observation.sixStepWindowSelection === null
    || !sameCanonical(terminal.sixStepWindowSelection, observation.sixStepWindowSelection)
    || terminal.sixStepSourceLedger.fsynced !== true
    || terminal.sixStepSourceLedger.snapshotPath.length === 0
    || terminal.sixStepSourceLedger.byteLength === "0"
    || terminal.sixStepBoundaryFiles.length === 0
    || terminal.sixStepBoundaryFiles.some(file => file.fsynced !== true
      || file.name.length === 0 || file.byteLength === "0")) {
    throw new TypeError("root-owned terminal physical fsync/window/artifact splice");
  }
}

function duplicateBasisReasons(observation: RawPerformanceObservationV1): readonly string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const event of observation.events) {
    if (event.eventType !== "route-denominator"
      && event.eventType !== "candidate-set"
      && event.eventType !== "performance-facts-complete") continue;
    const payload = ownRecord(event.payload, `basis.event[${event.sequence}].payload`);
    const admissionId = hash(payload.admissionId, `basis.event[${event.sequence}].payload.admissionId`);
    const laneKey = event.eventType === "route-denominator"
      ? `:${lane(payload.lane, `basis.event[${event.sequence}].payload.lane`)}`
      : "";
    const key = `${event.eventType}:${admissionId}${laneKey}`;
    if (seen.has(key)) reasons.push(`duplicate-${event.eventType}-admission`);
    seen.add(key);
  }
  return Object.freeze([...new Set(reasons)].sort());
}

function sixStepPartitionReasons(observation: RawPerformanceObservationV1): readonly string[] {
  const selected = new Map<string, Readonly<Record<string, unknown>>>();
  const selectedPassed = new Set<string>();
  const routeSelected = new Map<string, Readonly<Record<string, unknown>>>();
  const observedCandidates: Array<Readonly<{ readonly admissionId: Hash; readonly candidateId: Hash }>> = [];
  const performanceAdmissions = new Map<Hash, ObservedProductionEventV1[]>();
  for (const event of observation.events) {
    if (event.eventType === "performance-facts-complete" || event.eventType === "performance-facts-incomplete") {
      const admissionId = hash(event.payload.admissionId, `sixStepPartition[${event.sequence}].performanceAdmissionId`);
      performanceAdmissions.set(admissionId, [...performanceAdmissions.get(admissionId) ?? [], event]);
    }
    if (event.eventType === "candidate-set") {
      const payload = candidatePayload(event);
      for (const terminal of payload.candidateTerminalObservations) {
        const record = terminal as unknown as Readonly<Record<string, unknown>>;
        if (record.disposition === "selected") {
          const key = `${payload.admissionId}:${terminal.lane}:${terminal.candidateId}`;
          selected.set(key, record);
          if (record.terminalKind === "passed") selectedPassed.add(key);
        }
      }
    } else if (event.eventType === "route-denominator") {
      const payload = routePayload(event);
      if (payload.denominatorKind === "accounted") {
        for (const entry of payload.accounting.entries) {
          if (entry.disposition === "selected") {
            routeSelected.set(`${payload.admissionId}:${payload.lane}:${entry.candidateId}`, entry);
          }
        }
      }
    } else if (event.eventType === "performance-facts-complete") {
      const payload = ownRecord(event.payload, `sixStepPartition[${event.sequence}].payload`);
      if (payload.sixStepFacts === null) continue;
      const runtimeFacts = ownRecord(payload.runtimeFacts, `sixStepPartition[${event.sequence}].runtimeFacts`);
      if (runtimeFacts.producerSchedulerJoin === null) continue;
      const join = ownRecord(runtimeFacts.producerSchedulerJoin, `sixStepPartition[${event.sequence}].producerSchedulerJoin`);
      observedCandidates.push(Object.freeze({
        admissionId: hash(payload.admissionId, "sixStepPartition.admissionId"),
        candidateId: hash(join.unsignedDryRunCandidateId, "sixStepPartition.candidateId"),
      }));
    }
  }
  const reasons: string[] = [];
  if (!sameCanonical([...selected.keys()].sort(), [...routeSelected.keys()].sort())) {
    reasons.push("selected-route-candidate-six-step-partition-mismatch");
  }
  for (const key of new Set([...selected.keys(), ...routeSelected.keys()])) {
    const terminal = selected.get(key);
    const route = routeSelected.get(key);
    if (terminal === undefined) reasons.push("selected-terminal-observation-missing");
    else if (route === undefined) reasons.push("orphan-selected-terminal-observation");
    else if (["candidateId", "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal"]
      .some(field => !sameCanonical(route[field], terminal[field]))) {
      reasons.push("selected-route-terminal-facts-mismatch");
    }
    const admissionId = hash(key.slice(0, key.indexOf(":")), "selectedPartition.admissionId");
    const performance = performanceAdmissions.get(admissionId) ?? [];
    if (performance.length === 0) reasons.push("selected-performance-fact-missing");
    else if (performance.length !== 1) reasons.push("duplicate-selected-performance-fact");
    else if (performance[0]!.eventType !== "performance-facts-complete") {
      reasons.push("selected-performance-fact-incomplete");
    }
  }
  const observed = new Set<string>();
  for (const candidate of observedCandidates) {
    const suffix = `:${candidate.candidateId}`;
    const prefix = `${candidate.admissionId}:`;
    const matches = [...selectedPassed].filter(key => key.startsWith(prefix) && key.endsWith(suffix));
    if (matches.length === 1) observed.add(matches[0]!);
    else reasons.push("orphan-six-step-lineage");
  }
  for (const key of selectedPassed) if (!observed.has(key)) reasons.push("selected-six-step-lineage-missing");
  return Object.freeze([...new Set(reasons)].sort());
}

function routeCandidateBijectionReasons(observation: RawPerformanceObservationV1): readonly string[] {
  const reasons: string[] = [];
  const routeLanes = new Map<string, RoutePayloadV1[]>();
  const routeCandidates = new Map<string, Readonly<Record<string, CanonicalJson>>[]>();
  const candidateSets = new Map<Hash, CandidateSetPayloadV1[]>();
  const candidateLanes = new Map<string, Readonly<Record<string, CanonicalJson>>[]>();
  const candidateTerminals = new Map<string, Readonly<Record<string, CanonicalJson>>[]>();
  const append = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    map.set(key, [...map.get(key) ?? [], value]);
  };
  for (const event of observation.events) {
    if (event.eventType === "route-denominator") {
      const route = routePayload(event);
      const laneKey = `${route.admissionId}\u001f${route.lane}`;
      append(routeLanes, laneKey, route);
      if (route.denominatorKind === "accounted") {
        for (const entry of route.accounting.entries) {
          append(routeCandidates, `${laneKey}\u001f${entry.candidateId}`, entry);
        }
      }
    } else if (event.eventType === "candidate-set") {
      const payload = candidatePayload(event);
      candidateSets.set(payload.admissionId, [...candidateSets.get(payload.admissionId) ?? [], payload]);
      for (const candidateLane of payload.laneDenominators) {
        append(candidateLanes, `${payload.admissionId}\u001f${candidateLane.lane}`, candidateLane);
      }
      for (const terminal of payload.candidateTerminalObservations) {
        append(candidateTerminals, `${payload.admissionId}\u001f${terminal.lane}\u001f${terminal.candidateId}`, terminal);
      }
    }
  }
  for (const [laneKey, routes] of routeLanes) {
    if (routes.length !== 1) reasons.push("route-lane-identity-duplicate");
    const route = routes[0]!;
    const sets = candidateSets.get(route.admissionId) ?? [];
    if (sets.length === 0) {
      reasons.push("route-candidate-set-missing");
      continue;
    }
    if (sets.length !== 1) reasons.push("route-candidate-set-ambiguous");
    const payload = sets[0]!;
    if (!sameCanonical(headIdentity(route), headIdentity(payload))) reasons.push("route-candidate-head-mismatch");
    const lanes = candidateLanes.get(laneKey) ?? [];
    if (route.denominatorKind === "no-input") {
      if (lanes.length !== 0) reasons.push("no-input-route-has-candidate-lane");
      if ([...candidateTerminals.keys()].some(key => key.startsWith(`${laneKey}\u001f`))) {
        reasons.push("no-input-route-has-candidate-terminal");
      }
      continue;
    }
    if (lanes.length === 0) reasons.push("candidate-lane-denominator-missing");
    else if (lanes.length !== 1) reasons.push("candidate-lane-denominator-duplicate");
    else if (!sameCanonical(
      laneIdentity({
        lane: route.lane,
        correlationId: route.correlationId,
        coverageRoot: route.coverageRoot,
        accountingRoot: route.accounting.root,
      }),
      laneIdentity({
        lane: lanes[0]!.lane as LaneV1,
        correlationId: lanes[0]!.correlationId as Hash,
        coverageRoot: lanes[0]!.coverageRoot as Hash,
        accountingRoot: lanes[0]!.accountingRoot as Hash,
      }),
    )) reasons.push("candidate-lane-denominator-mismatch");
  }
  for (const laneKey of candidateLanes.keys()) {
    if (!routeLanes.has(laneKey)) reasons.push("orphan-candidate-lane-denominator");
  }
  for (const [identity, routes] of routeCandidates) {
    if (routes.length !== 1) reasons.push("duplicate-route-candidate-identity");
    const terminals = candidateTerminals.get(identity) ?? [];
    if (terminals.length === 0) reasons.push("candidate-terminal-identity-missing");
    else if (terminals.length !== 1) reasons.push("duplicate-candidate-terminal-identity");
    else if (["candidateId", "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal"]
      .some(field => !sameCanonical(routes[0]![field], terminals[0]![field]))) {
      reasons.push("route-candidate-terminal-facts-mismatch");
    }
  }
  for (const [identity, terminals] of candidateTerminals) {
    if (terminals.length !== 1) reasons.push("duplicate-candidate-terminal-identity");
    if (!routeCandidates.has(identity)) reasons.push("orphan-candidate-terminal-identity");
  }
  return Object.freeze([...new Set(reasons)].sort());
}

function selectedExecutionTelemetryReasons(observation: RawPerformanceObservationV1): readonly string[] {
  const reasons: string[] = [];
  const candidates = new Map<Hash, CandidateSetPayloadV1[]>();
  for (const event of observation.events) {
    if (event.eventType !== "candidate-set") continue;
    const payload = candidatePayload(event);
    candidates.set(payload.admissionId, [...candidates.get(payload.admissionId) ?? [], payload]);
  }
  for (const event of observation.events) {
    if (event.eventType !== "performance-facts-complete" && event.eventType !== "performance-facts-incomplete") continue;
    const payload = ownRecord(event.payload, `executionTelemetry[${event.sequence}].payload`);
    const admissionId = hash(payload.admissionId, `executionTelemetry[${event.sequence}].admissionId`);
    const sets = candidates.get(admissionId) ?? [];
    if (sets.length === 0) continue;
    if (sets.length !== 1) {
      reasons.push("execution-telemetry-candidate-set-ambiguous");
      continue;
    }
    const passed = sets[0]!.candidateTerminalObservations.filter(terminal => (
      terminal.disposition === "selected" && terminal.terminalKind === "passed"
    ));
    if (passed.length > 1) reasons.push("multiple-passed-candidate-terminals");
    const runtimeFacts = ownRecord(payload.runtimeFacts, `executionTelemetry[${event.sequence}].runtimeFacts`);
    const hasScheduler = runtimeFacts.selectedSchedulerCompletion !== null;
    const hasJoin = runtimeFacts.producerSchedulerJoin !== null;
    const hasSixStep = payload.sixStepFacts !== null;
    const telemetryCount = Number(hasScheduler) + Number(hasJoin) + Number(hasSixStep);
    if (telemetryCount !== 0 && telemetryCount !== 3) reasons.push("selected-execution-telemetry-partial");
    if (passed.length === 0 && telemetryCount !== 0) {
      reasons.push("non-passed-candidate-has-selected-execution-telemetry");
      continue;
    }
    if (passed.length !== 1) continue;
    if (telemetryCount !== 3) {
      reasons.push("passed-candidate-selected-execution-telemetry-missing");
      continue;
    }
    try {
      const terminal = passed[0]!;
      const join = ownRecord(runtimeFacts.producerSchedulerJoin, `executionTelemetry[${event.sequence}].producerSchedulerJoin`);
      const sixStep = ownRecord(payload.sixStepFacts, `executionTelemetry[${event.sequence}].sixStepFacts`);
      const stage36 = ownRecord(sixStep.stage36, `executionTelemetry[${event.sequence}].stage36`);
      const resolved = ownRecord(stage36.resolved, `executionTelemetry[${event.sequence}].resolved`);
      const executionProgram = ownRecord(resolved.executionProgram, `executionTelemetry[${event.sequence}].executionProgram`);
      const executionOwner = ownRecord(resolved.executionProgramOwnerEvidence, `executionTelemetry[${event.sequence}].executionOwner`);
      const finalSimulation = ownRecord(resolved.finalSimulation, `executionTelemetry[${event.sequence}].finalSimulation`);
      const finalOwner = ownRecord(resolved.finalSimulationOwnerEvidence, `executionTelemetry[${event.sequence}].finalOwner`);
      const unsignedDryRun = ownRecord(resolved.unsignedDryRun, `executionTelemetry[${event.sequence}].unsignedDryRun`);
      if (join.unsignedDryRunCandidateId !== terminal.candidateId
        || join.unsignedDryRunLineageHash !== terminal.terminalLineageHash
        || sixStep.stage36Root !== terminal.sixStepEvidenceRoot
        || resolved.routeCandidateId !== terminal.candidateId
        || executionProgram.programHash !== join.programHash
        || finalSimulation.receiptHash !== join.finalSimulationReceiptHash
        || unsignedDryRun.candidateId !== terminal.candidateId
        || unsignedDryRun.lineageHash !== terminal.terminalLineageHash
        || typeof executionOwner.evidenceRoot !== "string"
        || typeof finalOwner.evidenceRoot !== "string") {
        reasons.push("passed-candidate-selected-execution-lineage-mismatch");
      }
    } catch {
      reasons.push("passed-candidate-selected-execution-lineage-invalid");
    }
  }
  if (observation.databaseSha256Before !== observation.databaseSha256After
    || observation.storageSetRootBefore !== observation.storageSetRootAfter) {
    reasons.push("selected-execution-process-storage-not-stable");
  }
  return Object.freeze([...new Set(reasons)].sort());
}

function selectedTerminalOutcome(
  terminal: Readonly<Record<string, unknown>> | null,
  differences: readonly CanonicalJson[],
): Readonly<Record<string, CanonicalJson>> {
  if (terminal === null || differences.length > 0) {
    return Object.freeze({
      outcome: "invalid-basis",
      simulationStatus: "invalid-basis",
      simulationAbsenceReason: terminal === null
        ? "terminal-observation-missing"
        : "route-terminal-facts-mismatch",
    });
  }
  const terminalKind = nonEmptyString(terminal.terminalKind, "selectedOutcome.terminalKind");
  const reasonCode = terminal.reasonCode === null
    ? null
    : nonEmptyString(terminal.reasonCode, "selectedOutcome.reasonCode");
  if (terminalKind === "passed") {
    return Object.freeze({ outcome: "passed", simulationStatus: "passed", simulationAbsenceReason: null });
  }
  if (terminalKind === "chainProvenRejected" && reasonCode === "final-sim:simulation-reverted") {
    return Object.freeze({ outcome: "simulation-reverted", simulationStatus: "reverted", simulationAbsenceReason: null });
  }
  if (terminalKind === "retryable") {
    return Object.freeze({
      outcome: "retryable",
      simulationStatus: "absent",
      simulationAbsenceReason: reasonCode ?? "terminal:retryable-before-final-sim",
    });
  }
  if (terminalKind === "invalidProgram") {
    return Object.freeze({
      outcome: "invalid",
      simulationStatus: "absent",
      simulationAbsenceReason: reasonCode ?? "terminal:invalid-program-before-final-sim",
    });
  }
  return Object.freeze({
    outcome: "no-sim",
    simulationStatus: "absent",
    simulationAbsenceReason: reasonCode ?? `terminal:${terminalKind}-before-final-sim`,
  });
}

interface FullFamilyTerminalBindingObservationV1 {
  readonly bindingRoot: Hash;
  readonly terminalKind: "unsigned-dry-run" | "route-set-terminal";
  readonly terminalLineageHash: Hash;
  readonly audit: NativeFullFamilyAuditV1;
}

function appendSixStepLineageFacts(
  records: PreReleaseFactLogRecordV1[],
  observation: RawPerformanceObservationV1,
): void {
  const candidates = new Map<Hash, CandidateSetPayloadV1>();
  for (const event of observation.events.filter(value => value.eventType === "candidate-set")) {
    const payload = candidatePayload(event);
    if (candidates.has(payload.admissionId)) continue;
    candidates.set(payload.admissionId, payload);
  }
  for (const event of observation.events.filter(value => value.eventType === "performance-facts-complete")) {
    const payload = ownRecord(event.payload, `performance[${event.sequence}].payload`);
    const admissionId = hash(payload.admissionId, `performance[${event.sequence}].payload.admissionId`);
    const runtimeFacts = ownRecord(payload.runtimeFacts, `performance[${event.sequence}].payload.runtimeFacts`);
    const join = runtimeFacts.producerSchedulerJoin === null
      ? null
      : ownRecord(runtimeFacts.producerSchedulerJoin, `performance[${event.sequence}].payload.runtimeFacts.producerSchedulerJoin`);
    const sixStep = payload.sixStepFacts === null
      ? null
      : ownRecord(payload.sixStepFacts, `performance[${event.sequence}].payload.sixStepFacts`);
    if (join === null || sixStep === null) continue;
    const selectedId = hash(join.unsignedDryRunCandidateId, `performance[${event.sequence}].producerSchedulerJoin.unsignedDryRunCandidateId`);
    const terminal = candidates.get(admissionId)?.candidateTerminalObservations.find(candidate => (
      candidate.candidateId === selectedId && candidate.terminalKind === "passed"
    )) as (Readonly<Record<string, unknown>> & { readonly candidateId: Hash }) | undefined;
    if (terminal === undefined) continue;
    const stage36 = ownRecord(sixStep.stage36, `performance[${event.sequence}].payload.sixStepFacts.stage36`);
    const resolved = ownRecord(stage36.resolved, `performance[${event.sequence}].payload.sixStepFacts.stage36.resolved`);
    const executionProgram = ownRecord(resolved.executionProgram, `performance[${event.sequence}].stage36.resolved.executionProgram`);
    const executionOwner = ownRecord(resolved.executionProgramOwnerEvidence, `performance[${event.sequence}].stage36.resolved.executionProgramOwnerEvidence`);
    const finalSimulation = ownRecord(resolved.finalSimulation, `performance[${event.sequence}].stage36.resolved.finalSimulation`);
    const finalOwner = ownRecord(resolved.finalSimulationOwnerEvidence, `performance[${event.sequence}].stage36.resolved.finalSimulationOwnerEvidence`);
    const unsignedDryRun = ownRecord(resolved.unsignedDryRun, `performance[${event.sequence}].stage36.resolved.unsignedDryRun`);
    if (terminal.disposition !== "selected"
      || terminal.terminalLineageHash !== join.unsignedDryRunLineageHash
      || terminal.sixStepEvidenceRoot !== sixStep.stage36Root
      || resolved.routeCandidateId !== selectedId
      || executionProgram.programHash !== join.programHash
      || finalSimulation.receiptHash !== join.finalSimulationReceiptHash
      || unsignedDryRun.candidateId !== selectedId
      || unsignedDryRun.lineageHash !== join.unsignedDryRunLineageHash) {
      continue;
    }
    records.push(record("aloha.pre-release-six-step-selected-lineage-v1", {
      event: eventIdentity(event),
      processEvidence: Object.freeze({
        databaseSha256Before: observation.databaseSha256Before,
        databaseSha256After: observation.databaseSha256After,
        storageSetRootBefore: observation.storageSetRootBefore,
        storageSetRootAfter: observation.storageSetRootAfter,
        rawRowRoot: observation.rawRowRoot,
        eventRoot: observation.eventRoot,
        selectedPerformanceEventId: event.eventId,
      }),
      admissionId,
      candidateId: selectedId,
      terminalLineageHash: hash(terminal.terminalLineageHash, "sixStep.terminalLineageHash"),
      sixStepEvidenceRoot: hash(terminal.sixStepEvidenceRoot, "sixStep.sixStepEvidenceRoot"),
      stage12Root: hash(sixStep.stage12Root, "sixStep.stage12Root"),
      stage36Root: hash(sixStep.stage36Root, "sixStep.stage36Root"),
      sixStepLineageRoot: hash(sixStep.lineageRoot, "sixStep.lineageRoot"),
      correlationId: hash(join.correlationId, "sixStep.join.correlationId"),
      generationId: nonEmptyString(join.generationId, "sixStep.join.generationId"),
      source: join.source as CanonicalJson,
      programHash: hash(join.programHash, "sixStep.join.programHash"),
      executionOwnerEvidenceRoot: hash(executionOwner.evidenceRoot, "sixStep.executionOwnerEvidenceRoot"),
      stage12Snapshot: sixStep.stage12 as CanonicalJson,
      stage36Trace: sixStep.stage36 as CanonicalJson,
      executionProgram: executionProgram as CanonicalJson,
      executionProgramOwnerEvidence: executionOwner as CanonicalJson,
      schedulerCompletion: runtimeFacts.selectedSchedulerCompletion as CanonicalJson,
      finalSimulationReceiptHash: hash(join.finalSimulationReceiptHash, "sixStep.join.finalSimulationReceiptHash"),
      finalSimulationEffectsHash: hash(finalSimulation.effectsHash, "sixStep.finalSimulation.effectsHash"),
      finalSimulationOwnerEvidenceRoot: hash(finalOwner.evidenceRoot, "sixStep.finalSimulationOwnerEvidenceRoot"),
      finalSimulation: finalSimulation as CanonicalJson,
      finalSimulationOwnerEvidence: finalOwner as CanonicalJson,
      unsignedDryRun: unsignedDryRun as CanonicalJson,
    }));
  }
}

const NATIVE_PRICING_MODEL = "per-route-fresh-no-price-table" as const;
const NATIVE_PRICING_NOT_APPLICABLE = Object.freeze([
  "mids", "refreshed", "carried", "implementation-coordinator", "price-cache",
] as const);

function nativeRouteEntryLegs(entry: Readonly<Record<string, CanonicalJson>> | null): readonly Hash[] | null {
  if (entry === null || !Array.isArray(entry.legs)) return null;
  try {
    return Object.freeze(entry.legs.map((rawLeg, index) => {
      const leg = ownRecord(rawLeg, `nativeAudit.routeEntry.legs[${index}]`);
      return hash(leg.edgeId, `nativeAudit.routeEntry.legs[${index}].edgeId`);
    }));
  } catch {
    return null;
  }
}

function nativeProductionCoarseInputs(
  route: AccountedRoutePayloadV1,
  entry: Readonly<Record<string, CanonicalJson>>,
  terminalBinding: FullFamilyTerminalBindingObservationV1,
): readonly CanonicalJson[] {
  const audit = terminalBinding.audit;
  const matches = audit.coarseRoutes.filter(routeFact => routeFact.candidateId === entry.candidateId);
  if (matches.length !== 1
    || !nativeProductionRouteBindingMatches(route, terminalBinding)) return Object.freeze([]);
  const routeFact = matches[0]!;
  const routeLegs = nativeRouteEntryLegs(entry);
  if (entry.routeHash !== routeFact.routeHash
    || routeLegs === null
    || routeLegs.length !== routeFact.legs.length
    || routeLegs.some((edgeId, index) => edgeId !== routeFact.legs[index]!.edgeId)) return Object.freeze([]);
  return Object.freeze(routeFact.legs.map(leg => Object.freeze({
    legIndex: leg.legIndex,
    edgeId: leg.edgeId,
    owningFamilyId: leg.owningFamilyId,
    projectionHash: leg.projectionHash,
    coarseReceipt: leg.receipt as unknown as CanonicalJson | null,
    familyObservation: leg.familyObservation,
    coarseLegFactRoot: leg.factRoot,
    source: "native-full-family-audit",
  })));
}

function nativeProductionRouteBindingMatches(
  route: AccountedRoutePayloadV1,
  terminalBinding: FullFamilyTerminalBindingObservationV1,
): boolean {
  const accounting = route.accounting as Readonly<Record<string, CanonicalJson>>;
  const binding = terminalBinding.audit.binding;
  return route.correlationId === binding.correlationId
    && accounting.planningProblemHash === binding.planningProblemHash
    && accounting.enumerationRoot === binding.plannerEnumerationRoot
    && route.headHash === binding.actualCurrentSource.hash;
}

function appendNativeFullFamilyAuditFacts(
  records: PreReleaseFactLogRecordV1[],
  observation: RawPerformanceObservationV1,
  sweep: FullGraphCoarseSweepV1,
  terminalBinding: FullFamilyTerminalBindingObservationV1,
  sourceClassification: FactSourceClassificationV1,
): void {
  const audit = terminalBinding.audit;
  const routeEvents = observation.events.filter(event => event.eventType === "route-denominator");
  const candidateEvents = observation.events.filter(event => event.eventType === "candidate-set");
  const summaryReasons: string[] = [];
  const addReason = (reasons: string[], reason: string) => {
    reasons.push(reason);
    summaryReasons.push(reason);
  };

  records.push(record("aloha.pre-release-native-full-family-graph-join-v1", {
    terminalBindingRoot: terminalBinding.bindingRoot,
    nativeAuditRoot: audit.auditRoot,
    auditReadyRecordHash: audit.binding.readyRecordHash,
    auditGenerationId: audit.binding.generationId,
    auditGraphRoot: audit.binding.graphRoot,
    auditActualCurrentSource: audit.binding.actualCurrentSource as unknown as CanonicalJson,
    sweepBindingRoot: sweep.binding.bindingRoot,
    sweepGraphRoot: sweep.binding.graphRoot,
    sweepActualCurrentSource: sweep.binding.actualCurrentSource as unknown as CanonicalJson,
    relation: "independent-production-audit-vs-post-terminal-full-graph-observation",
    productionPricePublication: false,
    artifactRole: "independent-full-graph-coverage-observation",
  }, sourceClassification));

  for (const [index, edge] of audit.projectedEdges.entries()) {
    records.push(record("aloha.pre-release-native-full-family-projected-edge-v1", {
      terminalBindingRoot: terminalBinding.bindingRoot,
      nativeAuditRoot: audit.auditRoot,
      projectedEdgeIndex: String(index),
      edgeId: edge.edgeId,
      owningFamilyId: edge.owningFamilyId,
      owningFamilyDefinitionHash: edge.owningFamilyDefinitionHash,
      owningInstanceKey: edge.owningInstanceKey,
      instancePublicationHash: edge.instancePublicationHash,
      projectionHash: edge.projectionHash,
      projectedEdgeFactRoot: edge.factRoot,
      pricingModel: NATIVE_PRICING_MODEL,
      pricingStateNotApplicable: NATIVE_PRICING_NOT_APPLICABLE,
      productionPricePublication: false,
    }, sourceClassification));
  }

  for (const [routeIndex, auditRoute] of audit.coarseRoutes.entries()) {
    const reasons: string[] = [];
    const candidateRouteEvents = routeEvents.flatMap(event => {
      const payload = routePayload(event);
      if (payload.denominatorKind !== "accounted") return [];
      const accounting = payload.accounting as Readonly<Record<string, CanonicalJson>>;
      const entries = accounting.entries as readonly Readonly<Record<string, CanonicalJson>>[];
      const entry = entries.find(value => value.candidateId === auditRoute.candidateId) ?? null;
      return entry === null ? [] : [{ event, payload, accounting, entry }];
    });
    if (candidateRouteEvents.length === 0) addReason(reasons, "native-audit-candidate-route-missing");
    const exactDenominators = candidateRouteEvents.filter(({ payload, accounting }) => (
      payload.correlationId === audit.binding.correlationId
      && accounting.planningProblemHash === audit.binding.planningProblemHash
      && accounting.enumerationRoot === audit.binding.plannerEnumerationRoot
    ));
    if (exactDenominators.length === 0) addReason(reasons, "native-audit-production-route-denominator-missing");
    if (exactDenominators.length > 1) addReason(reasons, "native-audit-production-route-denominator-ambiguous");
    const joined = exactDenominators.length === 1 ? exactDenominators[0]! : null;
    if (joined !== null && joined.payload.headHash !== audit.binding.actualCurrentSource.hash) {
      addReason(reasons, "native-audit-source-mismatch");
    }
    if (joined !== null && joined.entry.routeHash !== auditRoute.routeHash) {
      addReason(reasons, "native-audit-route-hash-mismatch");
    }
    if (auditRoute.assessment === null) addReason(reasons, "native-audit-coarse-assessment-missing");
    if (auditRoute.legs.some(leg => leg.receipt === null || leg.familyObservation === null)) {
      addReason(reasons, "native-audit-coarse-leg-receipt-missing");
    }
    const routeLegEdgeIds = nativeRouteEntryLegs(joined?.entry ?? null);
    const auditLegEdgeIds = Object.freeze(auditRoute.legs.map(leg => leg.edgeId));
    if (routeLegEdgeIds === null
      || routeLegEdgeIds.length !== auditLegEdgeIds.length
      || routeLegEdgeIds.some((edgeId, index) => edgeId !== auditLegEdgeIds[index])) {
      addReason(reasons, "native-audit-coarse-leg-lineage-mismatch");
    }
    const actionMatches = audit.actionLineage.filter(action => action.candidateId === auditRoute.candidateId);
    const action = actionMatches.length === 1 ? actionMatches[0]! : null;
    if (actionMatches.length > 1
      || (action !== null && (action.routeHash !== auditRoute.routeHash
        || action.orderedEdgeIds.length !== auditLegEdgeIds.length
        || action.orderedEdgeIds.some((edgeId, index) => edgeId !== auditLegEdgeIds[index])))) {
      addReason(reasons, "native-audit-selected-tail-lineage-missing");
    }

    const routeLineageExact = joined !== null
      && joined.payload.headHash === audit.binding.actualCurrentSource.hash
      && joined.entry.routeHash === auditRoute.routeHash
      && routeLegEdgeIds !== null
      && routeLegEdgeIds.length === auditLegEdgeIds.length
      && routeLegEdgeIds.every((edgeId, index) => edgeId === auditLegEdgeIds[index]);
    const terminalMatches = !routeLineageExact || joined === null ? [] : candidateEvents.flatMap(event => {
      const payload = candidatePayload(event);
      const laneDenominators = payload.laneDenominators.filter(denominator => (
        denominator.lane === joined.payload.lane
        && denominator.correlationId === joined.payload.correlationId
        && denominator.accountingRoot === joined.accounting.root
      ));
      if (payload.admissionId !== joined.payload.admissionId
        || payload.headFactsRoot !== joined.payload.headFactsRoot
        || payload.headHash !== joined.payload.headHash
        || laneDenominators.length !== 1) return [];
      return payload.candidateTerminalObservations.flatMap(terminal => (
        terminal.lane === joined.payload.lane
        && terminal.candidateId === auditRoute.candidateId
          ? [{ event, payload, terminal }]
          : []
      ));
    });
    const terminalMatch = terminalMatches.length === 1 ? terminalMatches[0]! : null;
    const terminal = terminalMatch?.terminal as unknown as Readonly<Record<string, unknown>> | undefined;
    const terminalKind = typeof terminal?.terminalKind === "string" ? terminal.terminalKind : null;
    const selected = joined?.entry.disposition === "selected";
    const expectsAction = audit.missingActionCandidateIds.includes(auditRoute.candidateId)
      || action !== null;
    const terminalRouteHashMatches = terminal !== undefined && terminal.routeHash === auditRoute.routeHash;
    if (terminal !== undefined && !terminalRouteHashMatches) {
      addReason(reasons, "native-audit-terminal-route-hash-mismatch");
    }
    const sixStepMatches = !routeLineageExact || joined === null ? [] : records.filter(value => (
      value.kind === "aloha.pre-release-six-step-selected-lineage-v1"
      && value.admissionId === joined.payload.admissionId
      && value.candidateId === auditRoute.candidateId
      && value.correlationId === audit.binding.correlationId
      && sameCanonical(value.source, audit.binding.actualCurrentSource)
    ));
    const sixStepLineage = sixStepMatches.length === 1 ? sixStepMatches[0]! : null;
    if (selected && (terminalMatch === null || terminalMatches.length !== 1
      || !terminalRouteHashMatches
      || (expectsAction && action === null)
      || (terminalKind === "passed" && sixStepLineage === null))) {
      addReason(reasons, "native-audit-selected-tail-lineage-missing");
    }
    const outcome = terminal === undefined || !terminalRouteHashMatches
      ? Object.freeze({
        outcome: "invalid-basis",
        simulationStatus: "invalid-basis",
        simulationAbsenceReason: terminal === undefined ? "terminal-observation-missing" : "terminal-route-hash-mismatch",
      })
      : selectedTerminalOutcome(terminal, Object.freeze([]));
    const tailStatus = terminalRouteHashMatches && terminalKind === "passed"
      ? "simulated"
      : terminal === undefined || !terminalRouteHashMatches
        ? "missing"
        : "no-sim";

    records.push(record("aloha.pre-release-native-full-family-route-v1", {
      terminalBindingRoot: terminalBinding.bindingRoot,
      nativeAuditRoot: audit.auditRoot,
      routeIndex: String(routeIndex),
      candidateId: auditRoute.candidateId,
      routeHash: auditRoute.routeHash,
      routeBindingHash: auditRoute.routeBindingHash,
      coarseAssessment: auditRoute.assessment as unknown as CanonicalJson | null,
      routeFactRoot: auditRoute.routeFactRoot,
      productionRouteEvent: joined === null ? null : eventIdentity(joined.event),
      productionAdmissionId: joined?.payload.admissionId ?? null,
      productionAccountingRoot: joined === null ? null : hash(joined.accounting.root, "nativeAudit.accounting.root"),
      productionRouteEntry: joined?.entry as CanonicalJson | null ?? null,
      consistencyStatus: reasons.length === 0 ? "consistent" : "inconsistent",
      advisoryReasons: Object.freeze([...new Set(reasons)].sort()),
      pricingModel: NATIVE_PRICING_MODEL,
      pricingStateNotApplicable: NATIVE_PRICING_NOT_APPLICABLE,
      productionPricePublication: false,
    }, sourceClassification));

    for (const [legIndex, leg] of auditRoute.legs.entries()) {
      const legReasons: string[] = [];
      if (leg.receipt === null || leg.familyObservation === null) {
        addReason(legReasons, "native-audit-coarse-leg-receipt-missing");
      }
      if (routeLegEdgeIds === null || routeLegEdgeIds[legIndex] !== leg.edgeId) {
        addReason(legReasons, "native-audit-coarse-leg-lineage-mismatch");
      }
      records.push(record("aloha.pre-release-native-full-family-coarse-leg-v1", {
        terminalBindingRoot: terminalBinding.bindingRoot,
        nativeAuditRoot: audit.auditRoot,
        candidateId: auditRoute.candidateId,
        routeHash: auditRoute.routeHash,
        legIndex: String(legIndex),
        edgeId: leg.edgeId,
        owningFamilyId: leg.owningFamilyId,
        owningFamilyDefinitionHash: leg.owningFamilyDefinitionHash,
        owningInstanceKey: leg.owningInstanceKey,
        instancePublicationHash: leg.instancePublicationHash,
        projectionHash: leg.projectionHash,
        coarseReceipt: leg.receipt as unknown as CanonicalJson | null,
        familyObservation: leg.familyObservation,
        coarseLegFactRoot: leg.factRoot,
        consistencyStatus: legReasons.length === 0 ? "consistent" : "inconsistent",
        advisoryReasons: Object.freeze([...new Set(legReasons)].sort()),
        pricingModel: NATIVE_PRICING_MODEL,
        pricingStateNotApplicable: NATIVE_PRICING_NOT_APPLICABLE,
        productionPricePublication: false,
      }, sourceClassification));
    }

    records.push(record("aloha.pre-release-native-full-family-candidate-lineage-v1", {
      terminalBindingRoot: terminalBinding.bindingRoot,
      nativeAuditRoot: audit.auditRoot,
      correlationId: audit.binding.correlationId,
      planningProblemHash: audit.binding.planningProblemHash,
      enumerationRoot: audit.binding.plannerEnumerationRoot,
      source: audit.binding.actualCurrentSource as unknown as CanonicalJson,
      candidateId: auditRoute.candidateId,
      routeHash: auditRoute.routeHash,
      orderedEdgeIds: auditLegEdgeIds,
      coarseAssessment: auditRoute.assessment as unknown as CanonicalJson | null,
      actionLineage: action as unknown as CanonicalJson | null,
      terminalObservation: terminalMatch?.terminal as unknown as CanonicalJson | null ?? null,
      sixStepLineage,
      tailStatus,
      terminalBindingKind: terminalBinding.terminalKind,
      terminalBindingLineageHash: terminalBinding.terminalLineageHash,
      ...outcome,
      consistencyStatus: reasons.length === 0 ? "consistent" : "inconsistent",
      advisoryReasons: Object.freeze([...new Set(reasons)].sort()),
      productionPricePublication: false,
    }, sourceClassification));
  }

  const enumeratedCandidateIds = Object.freeze(audit.coarseRoutes.map(route => route.candidateId));
  const coarseResolvedCandidateIds = Object.freeze(audit.coarseRoutes.flatMap(route => (
    route.assessment !== null && route.legs.every(leg => leg.receipt !== null && leg.familyObservation !== null)
      ? [route.candidateId]
      : []
  )));
  const admittedCandidateIds = Object.freeze([...new Set(routeEvents.flatMap(event => {
    const payload = routePayload(event);
    if (payload.denominatorKind !== "accounted" || payload.correlationId !== audit.binding.correlationId) return [];
    const accounting = payload.accounting as Readonly<Record<string, CanonicalJson>>;
    if (accounting.planningProblemHash !== audit.binding.planningProblemHash
      || accounting.enumerationRoot !== audit.binding.plannerEnumerationRoot) return [];
    return (accounting.entries as readonly Readonly<Record<string, CanonicalJson>>[])
      .flatMap(entry => entry.disposition === "selected" ? [entry.candidateId as Hash] : []);
  }))].sort());
  const finalSimulationCandidateIds = Object.freeze([...new Set(candidateEvents.flatMap(event => (
    candidatePayload(event).candidateTerminalObservations.flatMap(terminal => (
      terminal.terminalKind === "passed" ? [terminal.candidateId] : []
    ))
  )))].sort());
  const coarseInvalidCandidateIds = Object.freeze(enumeratedCandidateIds.filter(id => !coarseResolvedCandidateIds.includes(id)));
  const candidateRoot = (domain: string, values: readonly Hash[]) => observedOrderedRoot(domain, values);
  records.push(record("aloha.pre-release-native-full-family-audit-summary-v1", {
    terminalBindingRoot: terminalBinding.bindingRoot,
    nativeAuditRoot: audit.auditRoot,
    binding: audit.binding as unknown as CanonicalJson,
    expectedCandidateCount: audit.expectedCandidateCount,
    expectedLegCount: audit.expectedLegCount,
    observedReceiptCount: audit.observedReceiptCount,
    missingLegCount: String(audit.missingLegKeys.length),
    expectedProjectedEdgeCount: audit.expectedProjectedEdgeCount,
    observedProjectedEdgeCount: audit.observedProjectedEdgeCount,
    missingProjectedEdgeCount: String(audit.missingProjectedEdgeIds.length),
    expectedActionLineageCount: audit.expectedActionLineageCount,
    observedActionLineageCount: audit.observedActionLineageCount,
    enumeratedCandidateCount: String(enumeratedCandidateIds.length),
    enumeratedCandidateRoot: candidateRoot("aloha/pre-release/native-summary/enumerated-candidates/v1", enumeratedCandidateIds),
    coarseResolvedCandidateCount: String(coarseResolvedCandidateIds.length),
    coarseResolvedCandidateRoot: candidateRoot("aloha/pre-release/native-summary/coarse-resolved-candidates/v1", coarseResolvedCandidateIds),
    coarseInvalidCandidateCount: String(coarseInvalidCandidateIds.length),
    coarseInvalidCandidateRoot: candidateRoot("aloha/pre-release/native-summary/coarse-invalid-candidates/v1", coarseInvalidCandidateIds),
    admittedCandidateCount: String(admittedCandidateIds.length),
    admittedCandidateRoot: candidateRoot("aloha/pre-release/native-summary/admitted-candidates/v1", admittedCandidateIds),
    exactCandidateCount: String(admittedCandidateIds.length),
    exactCandidateRoot: candidateRoot("aloha/pre-release/native-summary/exact-candidates/v1", admittedCandidateIds),
    finalSimulationCandidateCount: String(finalSimulationCandidateIds.length),
    finalSimulationCandidateRoot: candidateRoot("aloha/pre-release/native-summary/final-simulation-candidates/v1", finalSimulationCandidateIds),
    missingActionCandidateCount: String(audit.missingActionCandidateIds.length),
    missingActionCandidateRoot: candidateRoot("aloha/pre-release/native-summary/missing-action-candidates/v1", audit.missingActionCandidateIds),
    denominatorRoot: audit.denominatorRoot,
    observedReceiptRoot: audit.observedReceiptRoot,
    missingLegRoot: audit.missingLegRoot,
    projectedEdgeDenominatorRoot: audit.projectedEdgeDenominatorRoot,
    missingProjectedEdgeRoot: audit.missingProjectedEdgeRoot,
    actionDenominatorRoot: audit.actionDenominatorRoot,
    actionObservedRoot: audit.actionObservedRoot,
    consistencyStatus: summaryReasons.length === 0 ? "consistent" : "inconsistent",
    advisoryReasons: Object.freeze([...new Set(summaryReasons)].sort()),
    pricingModel: NATIVE_PRICING_MODEL,
    pricingStateNotApplicable: NATIVE_PRICING_NOT_APPLICABLE,
    productionPricePublication: false,
  }, sourceClassification));
}

function assertNativeProjectedEdgeDenominatorV1(
  audit: NativeFullFamilyAuditV1,
  activeGraph: ProductionActiveReadyGraphSnapshotV1,
): void {
  if (audit.expectedProjectedEdgeCount !== activeGraph.edgeCount
    || audit.projectedEdges.length !== activeGraph.orderedEdgeIds.length
    || audit.projectedEdges.some((edge, index) => edge.edgeId !== activeGraph.orderedEdgeIds[index])) {
    throw new TypeError("native full-family projected-edge/active Ready Graph denominator mismatch");
  }
}

function buildObservedPreReleaseFactLogRecordsV1(
  report: AdvisoryReportV1,
  observation: RawPerformanceObservationV1,
  sweep: FullGraphCoarseSweepV1,
  activeGraph: ProductionActiveReadyGraphSnapshotV1,
  terminalPhysical: PreReleaseBTerminalPhysicalObservationV1 | null,
  terminalBinding: FullFamilyTerminalBindingObservationV1 | null,
): readonly PreReleaseFactLogRecordV1[] {
  const records: PreReleaseFactLogRecordV1[] = [];
  if (terminalBinding !== null) {
    assertNativeProjectedEdgeDenominatorV1(terminalBinding.audit, activeGraph);
  }
  const encodedSweep = encodeFullGraphCoarseSweepV1(sweep);
  const basisReasons = [...observation.status === "raw-complete" ? [] : [
    `raw-observation-${observation.status}`,
  ], ...duplicateBasisReasons(observation), ...routeCandidateBijectionReasons(observation),
  ...selectedExecutionTelemetryReasons(observation), ...sixStepPartitionReasons(observation),
  ...terminalPhysical === null ? ["root-owned-terminal-physical-observer-not-executed"] : []];
  try {
    assertPhysicalGraphBasis(report, observation, sweep, activeGraph);
    if (terminalPhysical !== null) assertTerminalPhysicalBasis(report, observation, terminalPhysical);
  } catch (error) {
    basisReasons.push(error instanceof Error ? error.message : "root-owned-graph-basis-invalid");
  }
  const invalidBasis = basisReasons.length > 0;
  records.push(record("aloha.pre-release-fact-log-source-v1", {
    candidateReleaseCommit: report.release.candidateReleaseCommit,
    runtimeBindingId: report.release.runtimeBindingId,
    releaseProvenanceHash: report.release.releaseProvenanceHash,
    finalDurableWindowId: report.factIndex.terminalPhase.finalDurableWindowId,
    databasePath: report.factIndex.processEvidenceQuery.databasePath,
    databaseSha256Before: observation.databaseSha256Before,
    databaseSha256After: observation.databaseSha256After,
    storageSetRootBefore: observation.storageSetRootBefore,
    storageSetRootAfter: observation.storageSetRootAfter,
    rawObservationStatus: observation.status,
    rawObservationReasons: observation.reasons,
    rawRowRoot: observation.rawRowRoot,
    eventRoot: observation.eventRoot,
    reportedTerminalSnapshotTrustRoot: report.factBinding.terminalSnapshotTrustRoot,
    reportedTerminalSnapshotTrustRootSourceClassification: "self-consistent-unverified",
    checkpointSnapshotPublication: report.factLocators.frozenCheckpointSnapshotPublication as unknown as CanonicalJson,
    advisoryJudgmentRoot: report.judgmentRoot,
    sweepArtifactRefId: report.factIndex.terminalPhase.fullGraphCoarseSweep.artifactRefId,
    sweepContentSha256: report.factIndex.terminalPhase.fullGraphCoarseSweep.contentSha256,
    sweepRoot: sweep.sweepRoot,
    authority: Object.freeze({
      candidateGeneratedAuthority: null,
      runtimeReleaseBinding: null,
      releaseAuthority: null,
      submissionAuthority: null,
      sign: false,
      broadcast: false,
      promote: false,
    }),
    basisStatus: invalidBasis ? "invalid" : "complete",
    basisReasons: Object.freeze(basisReasons),
  }, invalidBasis ? "invalid-basis" : "raw-sqlite-observation"));
  appendNominationQualificationReuseClaims(records, report);
  for (const reason of observation.reasons) {
    records.push(record("aloha.pre-release-fact-error-v1", {
      source: "production-performance-observer",
      code: reason,
    }, "invalid-basis"));
  }
  for (const reason of basisReasons) {
    records.push(record("aloha.pre-release-fact-error-v1", {
      source: "physical-fact-basis",
      code: reason,
    }, "invalid-basis"));
  }
  records.push(record("aloha.pre-release-full-graph-summary-v1", {
    reportedTerminalSnapshotTrustRoot: report.factBinding.terminalSnapshotTrustRoot,
    reportedTerminalSnapshotTrustRootSourceClassification: "self-consistent-unverified",
    checkpointRootEnvelopeHash: activeGraph.checkpointRootEnvelopeHash,
    checkpointRevision: activeGraph.checkpointRevision,
    readyClosureStorageHash: activeGraph.readyClosureStorageHash,
    readyRecordHash: activeGraph.readyRecordHash,
    generationId: activeGraph.generationId,
    releaseProvenanceHash: activeGraph.releaseProvenanceHash,
    instanceCatalogRoot: activeGraph.instanceCatalogRoot,
    graphRoot: activeGraph.graphRoot,
    edgeCount: activeGraph.edgeCount,
    graphEdgeCount: activeGraph.edgeCount,
    familyEdgeCounts: activeGraph.familyEdgeCounts as unknown as CanonicalJson,
    binding: sweep.binding as unknown as CanonicalJson,
    expectedTransitionCount: sweep.expectedTransitionCount,
    expectedTransitionRoot: sweep.expectedTransitionRoot,
    observedTransitionCount: sweep.observedTransitionCount,
    coarseResolvedTransitionCount: sweep.observedTransitionCount,
    observedTransitionRoot: sweep.observedTransitionRoot,
    missingTransitionCount: sweep.missingTransitionCount,
    coarseInvalidTransitionCount: sweep.missingTransitionCount,
    missingTransitionRoot: sweep.missingTransitionRoot,
    familyTransitionCounts: sweep.familyTransitionCounts as unknown as CanonicalJson,
    entryChunkCount: encodedSweep.manifest.entryChunkCount,
    entryCount: encodedSweep.manifest.entryCount,
    firstEntryChunkRef: encodedSweep.manifest.firstEntryChunkRef as unknown as CanonicalJson,
    entryChunkClosureRoot: encodedSweep.manifest.entryChunkClosureRoot,
    sweepRoot: sweep.sweepRoot,
    productionPricePublication: false,
    artifactRole: "independent-full-graph-coverage-observation",
  }, invalidBasis ? "invalid-basis" : "root-owned-physical-observation"));
  records.push(record("aloha.pre-release-edge-observation-window-v1", {
    bindingRoot: sweep.binding.bindingRoot,
    recentObservationRange: sweep.binding.recentObservationRange,
  }, invalidBasis ? "invalid-basis" : "root-owned-physical-observation"));
  records.push(record("aloha.pre-release-current-source-coarse-binding-v1", {
    bindingRoot: sweep.binding.bindingRoot,
    currentSourceSessionId: sweep.binding.currentSourceSessionId,
    readyCutoff: sweep.binding.readyCutoff as unknown as CanonicalJson,
    actualCurrentSource: sweep.binding.actualCurrentSource as unknown as CanonicalJson,
  }, invalidBasis ? "invalid-basis" : "root-owned-physical-observation"));
  for (const entry of sweep.entries) {
    records.push(record("aloha.pre-release-full-graph-transition-v1", {
      ordinal: entry.ordinal,
      transitionId: entry.transitionId,
      owningFamilyId: entry.edge.owningFamilyId,
      status: entry.status,
      missingReason: entry.missingReason,
      coarseReceipt: entry.receipt as unknown as CanonicalJson | null,
      familyObservation: entry.familyObservation,
      entry: entry as unknown as CanonicalJson,
    }, invalidBasis ? "invalid-basis" : "root-owned-physical-observation"));
  }

  const routeEvents = observation.events.filter(event => event.eventType === "route-denominator");
  const candidateEvents = observation.events.filter(event => event.eventType === "candidate-set");
  const candidateByAdmission = new Map<Hash, { readonly event: ObservedProductionEventV1; readonly payload: CandidateSetPayloadV1 }>();
  const joinedHeadAdmissions = new Set<Hash>();
  const joinedCandidateLanes = new Set<string>();
  for (const event of candidateEvents) {
    const payload = candidatePayload(event);
    if (!candidateByAdmission.has(payload.admissionId)) {
      candidateByAdmission.set(payload.admissionId, { event, payload });
    }
    const terminalEntryRoots = payload.candidateTerminalObservations.map((terminal, index) => hashDomain(
      "aloha/pre-release/candidate-terminal-entry/v1",
      { ordinal: String(index), terminal: terminal as unknown as CanonicalJson },
    ));
    const laneDenominators = payload.laneDenominators.map(denominator => {
      const { observationRoots: _observationRoots, ...summary } = denominator as Readonly<Record<string, CanonicalJson>>;
      return Object.freeze(summary);
    });
    records.push(record("aloha.pre-release-candidate-set-v1", {
      event: eventIdentity(event),
      admissionId: payload.admissionId,
      headFactsRoot: payload.headFactsRoot,
      headHash: payload.headHash,
      laneDenominators: Object.freeze(laneDenominators),
      candidateTerminalObservationCount: String(payload.candidateTerminalObservations.length),
      candidateTerminalObservationSequenceRoot: observedOrderedRoot(
        "aloha/pre-release/candidate-terminal-observations/v1",
        terminalEntryRoots,
      ),
      reportedCandidateTerminalObservationSetRoot:
        (payload as Readonly<Record<string, CanonicalJson>>).candidateTerminalObservationSetRoot ?? null,
      materialLocator: materialLocator(report, event, "candidate-terminal-observations"),
    }));
    for (const [index, terminal] of payload.candidateTerminalObservations.entries()) {
      records.push(record("aloha.pre-release-candidate-terminal-v1", {
        event: eventIdentity(event),
        admissionId: payload.admissionId,
        terminalIndex: String(index),
        lane: terminal.lane,
        candidateId: terminal.candidateId,
        terminal: terminal as unknown as CanonicalJson,
      }));
    }
  }
  appendSixStepLineageFacts(records, observation);
  if (terminalBinding !== null) {
    appendNativeFullFamilyAuditFacts(
      records,
      observation,
      sweep,
      terminalBinding,
      invalidBasis ? "invalid-basis" : "root-owned-physical-observation",
    );
  }

  for (const routeEvent of routeEvents) {
    const route = routePayload(routeEvent);
    const accountingSummary = route.denominatorKind === "accounted"
      ? (() => {
          const { entries: _entries, ...summary } = route.accounting;
          return Object.freeze(summary);
        })()
      : null;
    const accountingEntryRoots = route.denominatorKind === "accounted"
      ? route.accounting.entries.map((entry, index) => hashDomain(
          "aloha/route-accounting-entry/v1",
          { ordinal: String(index), entry: entry as unknown as CanonicalJson },
        ))
      : [];
    records.push(record("aloha.pre-release-route-denominator-v1", {
      event: eventIdentity(routeEvent),
      admissionId: route.admissionId,
      headFactsRoot: route.headFactsRoot,
      headHash: route.headHash,
      lane: route.lane,
      correlationId: route.correlationId,
      coverageRoot: route.coverageRoot,
      denominatorKind: route.denominatorKind,
      accounting: accountingSummary as unknown as CanonicalJson | null,
      accountingEntryCount: String(accountingEntryRoots.length),
      accountingEntrySequenceRoot: observedOrderedRoot(
        "aloha/searcher-production-evidence-material/route-accounting-entries/entries/v1",
        accountingEntryRoots,
      ),
      materialLocator: route.denominatorKind === "accounted"
        ? materialLocator(report, routeEvent, "route-accounting-entries")
        : null,
    }));
    const headCandidateMatches = candidateEvents.flatMap(event => {
      const payload = candidatePayload(event);
      return payload.admissionId === route.admissionId
        && payload.headFactsRoot === route.headFactsRoot
        && payload.headHash === route.headHash
        ? [{ event, payload }]
        : [];
    });
    const exactCandidateMatches = route.denominatorKind === "no-input"
      ? headCandidateMatches
      : headCandidateMatches.filter(({ payload }) => payload.laneDenominators.filter(item => (
        item.lane === route.lane
        && item.correlationId === route.correlationId
        && item.coverageRoot === route.coverageRoot
        && item.accountingRoot === route.accounting.root
      )).length === 1);
    const candidate = exactCandidateMatches.length === 1 ? exactCandidateMatches[0]! : null;
    if (candidate !== null) joinedHeadAdmissions.add(route.admissionId);
    const headDifferences = compareFields(
      route,
      candidate?.payload ?? null,
      ["admissionId", "headFactsRoot", "headHash"],
    );
    records.push(record("aloha.pre-release-head-join-fact-v1", {
      routeEvent: eventIdentity(routeEvent),
      candidateSetEvent: candidate === null ? null : eventIdentity(candidate.event),
      identity: headIdentity(route),
      differences: headDifferences,
    }));

    if (route.denominatorKind === "no-input") {
      records.push(record("aloha.pre-release-lane-join-fact-v1", {
        routeEvent: eventIdentity(routeEvent),
        candidateSetEvent: candidate === null ? null : eventIdentity(candidate.event),
        identity: Object.freeze({
          head: headIdentity(route),
          lane: laneIdentity({
            lane: route.lane,
            correlationId: route.correlationId,
            coverageRoot: route.coverageRoot,
            accountingRoot: null,
          }),
        }),
        relation: "no-input-route-has-no-candidate-lane-denominator",
        differences: Object.freeze([]),
      }));
      records.push(record("aloha.pre-release-selected-exact-list-v1", {
        routeEvent: eventIdentity(routeEvent),
        admissionId: route.admissionId,
        lane: route.lane,
        denominatorKind: "no-input",
        accountingRoot: null,
        selectedCount: "0",
        selectedEntryRoot: observedOrderedRoot("aloha/pre-release/selected-route-entries/v1", []),
      }));
      continue;
    }
    const candidateLane = candidate?.payload.laneDenominators.find(item => item.lane === route.lane) ?? null;
    if (candidateLane !== null) joinedCandidateLanes.add(`${route.admissionId}\u001f${route.lane}`);
    const laneLeft = Object.freeze({
      lane: route.lane,
      correlationId: route.correlationId,
      coverageRoot: route.coverageRoot,
      accountingRoot: route.accounting.root,
    });
    const laneDifferences = compareFields(laneLeft, candidateLane, ["lane", "correlationId", "coverageRoot", "accountingRoot"]);
    records.push(record("aloha.pre-release-lane-join-fact-v1", {
      routeEvent: eventIdentity(routeEvent),
      candidateSetEvent: candidate === null ? null : eventIdentity(candidate.event),
      identity: Object.freeze({ head: headIdentity(route), lane: laneIdentity(laneLeft) }),
      candidateLane: candidateLane as unknown as CanonicalJson | null,
      differences: laneDifferences,
    }));

    const routeBindingExact = terminalBinding === null || nativeProductionRouteBindingMatches(route, terminalBinding);
    const terminals = routeBindingExact
      ? candidate?.payload.candidateTerminalObservations.filter(item => item.lane === route.lane) ?? []
      : [];
    const joinedTerminalIndexes = new Set<number>();
    const selected: CanonicalJson[] = [];
    for (const [index, entry] of route.accounting.entries.entries()) {
      records.push(record("aloha.pre-release-route-accounting-entry-v1", {
        routeEvent: eventIdentity(routeEvent),
        admissionId: route.admissionId,
        lane: route.lane,
        accountingRoot: route.accounting.root,
        accountingIndex: String(index),
        candidateId: entry.candidateId,
        entry: entry as unknown as CanonicalJson,
      }));
      if (entry.disposition === "selected") selected.push(entry as unknown as CanonicalJson);
      const terminalMatches = terminals.flatMap((terminal, terminalIndex) => (
        terminal.candidateId === entry.candidateId ? [{ terminal, terminalIndex }] : []
      ));
      const terminalMatch = terminalMatches.length === 1 ? terminalMatches[0]! : null;
      const terminal = terminalMatch?.terminal ?? null;
      if (terminalMatch !== null) joinedTerminalIndexes.add(terminalMatch.terminalIndex);
      const candidateDifferences = compareFields(
        entry,
        terminal,
        ["candidateId", "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal"],
      );
      records.push(record("aloha.pre-release-candidate-join-fact-v1", {
        routeEvent: eventIdentity(routeEvent),
        candidateSetEvent: candidate === null ? null : eventIdentity(candidate.event),
        identity: Object.freeze({
          head: headIdentity(route),
          lane: laneIdentity(laneLeft),
          candidate: Object.freeze({ lane: route.lane, candidateId: entry.candidateId }),
        }),
        routeAccountingIndex: String(index),
        terminalIndex: terminalMatch === null ? null : String(terminalMatch.terminalIndex),
        terminalMatchCount: String(terminalMatches.length),
        terminalCandidateId: terminal?.candidateId ?? null,
        routeEntry: entry as unknown as CanonicalJson,
        terminalObservation: terminal as unknown as CanonicalJson | null,
        differences: candidateDifferences,
      }));
      if (entry.disposition === "selected") {
        const terminalRecord = terminal as unknown as Readonly<Record<string, unknown>> | null;
        const performanceEvents = observation.events.filter(value => (
          (value.eventType === "performance-facts-complete" || value.eventType === "performance-facts-incomplete")
          && value.payload.admissionId === route.admissionId
        ));
        const performanceEvent = performanceEvents.length === 1 ? performanceEvents[0]! : null;
        const sixStepLineages = !routeBindingExact || candidateDifferences.length > 0 ? [] : records.filter(value => {
          if (value.kind !== "aloha.pre-release-six-step-selected-lineage-v1"
            || value.admissionId !== route.admissionId
            || value.candidateId !== entry.candidateId
            || value.correlationId !== route.correlationId) return false;
          const source = ownRecord(value.source, "selectedOutcome.sixStepLineage.source");
          return source.hash === route.headHash;
        });
        const sixStepLineage = sixStepLineages.length === 1 ? sixStepLineages[0]! : null;
        const outcome = selectedTerminalOutcome(terminalRecord, candidateDifferences);
        const coarseInputs = terminalBinding === null
          ? Object.freeze([])
          : nativeProductionCoarseInputs(route, entry, terminalBinding);
        records.push(record("aloha.pre-release-selected-terminal-outcome-v1", {
          routeEvent: eventIdentity(routeEvent),
          candidateSetEvent: candidate === null ? null : eventIdentity(candidate.event),
          admissionId: route.admissionId,
          lane: route.lane,
          candidateId: entry.candidateId,
          terminalKind: (terminalRecord?.terminalKind ?? null) as CanonicalJson,
          reasonCode: (terminalRecord?.reasonCode ?? null) as CanonicalJson,
          ...outcome,
          simulationEvidenceHash: (terminalRecord?.evidenceHash ?? null) as CanonicalJson,
          terminalLineageHash: (terminalRecord?.terminalLineageHash ?? null) as CanonicalJson,
          sixStepEvidenceRoot: (terminalRecord?.sixStepEvidenceRoot ?? null) as CanonicalJson,
          physicalSixStepLineage: sixStepLineage,
          physicalPerformanceEvent: performanceEvent === null ? null : eventIdentity(performanceEvent),
          physicalPerformanceFactStatus: performanceEvent?.eventType === "performance-facts-complete"
            ? "complete"
            : performanceEvent?.eventType === "performance-facts-incomplete"
              ? "incomplete"
              : null,
          coarseInputs,
          differences: candidateDifferences,
        }));
      }
    }
    for (const [index, terminal] of terminals.entries()) {
      if (joinedTerminalIndexes.has(index)) continue;
      records.push(record("aloha.pre-release-candidate-join-fact-v1", {
        routeEvent: eventIdentity(routeEvent),
        candidateSetEvent: candidate === null ? null : eventIdentity(candidate.event),
        identity: Object.freeze({
          head: headIdentity(route),
          lane: laneIdentity(laneLeft),
          candidate: Object.freeze({ lane: route.lane, candidateId: terminal.candidateId }),
        }),
        routeAccountingIndex: null,
        terminalIndex: String(index),
        terminalMatchCount: "0",
        terminalCandidateId: terminal.candidateId,
        routeEntry: null,
        terminalObservation: terminal as unknown as CanonicalJson,
        differences: compareFields(null, terminal, ["candidateId"]),
      }));
    }
    records.push(record("aloha.pre-release-selected-exact-list-v1", {
      routeEvent: eventIdentity(routeEvent),
      admissionId: route.admissionId,
      lane: route.lane,
      denominatorKind: "accounted",
      accountingRoot: route.accounting.root,
      selectedCount: String(selected.length),
      selectedEntryRoot: observedOrderedRoot("aloha/pre-release/selected-route-entries/v1", selected),
    }));
  }
  for (const { event, payload } of candidateByAdmission.values()) {
    if (!joinedHeadAdmissions.has(payload.admissionId)) {
      records.push(record("aloha.pre-release-head-join-fact-v1", {
        routeEvent: null,
        candidateSetEvent: eventIdentity(event),
        identity: headIdentity(payload),
        differences: compareFields(null, payload, ["admissionId", "headFactsRoot", "headHash"]),
      }));
    }
    for (const candidateLane of payload.laneDenominators) {
      const laneKey = `${payload.admissionId}\u001f${candidateLane.lane}`;
      if (joinedCandidateLanes.has(laneKey)) continue;
      records.push(record("aloha.pre-release-lane-join-fact-v1", {
        routeEvent: null,
        candidateSetEvent: eventIdentity(event),
        identity: Object.freeze({
          head: headIdentity(payload),
          lane: laneIdentity(candidateLane),
        }),
        candidateLane: candidateLane as unknown as CanonicalJson,
        differences: compareFields(null, candidateLane, ["lane", "correlationId", "coverageRoot", "accountingRoot"]),
      }));
      const terminals = payload.candidateTerminalObservations.filter(item => item.lane === candidateLane.lane);
      for (const [index, terminal] of terminals.entries()) {
        records.push(record("aloha.pre-release-candidate-join-fact-v1", {
          routeEvent: null,
          candidateSetEvent: eventIdentity(event),
          identity: Object.freeze({
            head: headIdentity(payload),
            lane: laneIdentity(candidateLane),
            candidate: Object.freeze({ lane: terminal.lane, candidateId: terminal.candidateId }),
          }),
          routeAccountingIndex: null,
          terminalIndex: String(index),
          terminalMatchCount: "0",
          terminalCandidateId: terminal.candidateId,
          routeEntry: null,
          terminalObservation: terminal as unknown as CanonicalJson,
          differences: compareFields(null, terminal, ["candidateId"]),
        }));
      }
    }
  }
  if (!invalidBasis) return Object.freeze(records);
  return Object.freeze(records.map(value => value.sourceClassification === SELF_CONSISTENT_ADVISORY_CLAIM
    ? value
    : Object.freeze({ ...value, sourceClassification: "invalid-basis" as const })));
}

/** Structural inputs are useful for mutation tests only and are always marked
 * invalid-basis. Production physical classification is reachable solely from
 * readPreReleaseFactLogV1 after the fixed root-owned observer executes. */
export function buildPreReleaseFactLogRecordsV1(
  report: AdvisoryReportV1,
  observation: RawPerformanceObservationV1,
  sweep: FullGraphCoarseSweepV1,
  activeGraph: ProductionActiveReadyGraphSnapshotV1,
  nativeAudit: NativeFullFamilyAuditV1 | null = null,
): readonly PreReleaseFactLogRecordV1[] {
  if (nativeAudit !== null) {
    validateNativeFullFamilyAuditWireV1(nativeAudit);
    const { auditRoot, ...body } = nativeAudit;
    if (encodeNativeFullFamilyAuditBodyV1(body).manifest.auditRoot !== auditRoot) {
      throw new TypeError("native full-family audit manifest root mismatch");
    }
  }
  const terminalBinding = nativeAudit === null ? null : Object.freeze({
    bindingRoot: hashDomain("aloha/pre-release-structural-native-audit-binding/v1", nativeAudit.auditRoot),
    terminalKind: "route-set-terminal" as const,
    terminalLineageHash: hashDomain("aloha/pre-release-structural-native-audit-lineage/v1", nativeAudit.auditRoot),
    audit: nativeAudit,
  });
  return buildObservedPreReleaseFactLogRecordsV1(report, observation, sweep, activeGraph, null, terminalBinding);
}

function readPreReleaseFactLogInputsV1(reportPath: string): Readonly<{
  readonly report: AdvisoryReportV1;
  readonly observation: RawPerformanceObservationV1;
  readonly sweep: FullGraphCoarseSweepV1;
  readonly activeGraph: ProductionActiveReadyGraphSnapshotV1;
  readonly terminalBinding: FullFamilyTerminalBindingObservationV1;
}> {
  const canonicalReportPath = absolutePath(resolve(reportPath), "reportPath");
  const reportBytes = readPhysicalFile(canonicalReportPath, {});
  const report = decodeReport(decodeCanonicalBytes(reportBytes));
  const indexBinding = decodeIndexAndBind(report);
  const databaseIdentity = report.factLocators.processEvidenceDatabase;
  const databaseBytes = readPhysicalFile(databaseIdentity.path, {
    device: databaseIdentity.device,
    inode: databaseIdentity.inode,
    contentSha256: databaseIdentity.contentSha256,
  });
  void databaseBytes;
  const observation = observeProductionPerformanceDatabaseV1(report.factIndex.processEvidenceQuery.databasePath);
  readPhysicalFile(databaseIdentity.path, {
    device: databaseIdentity.device,
    inode: databaseIdentity.inode,
    contentSha256: databaseIdentity.contentSha256,
  });
  if (observation.databaseSha256Before !== databaseIdentity.contentSha256
    || observation.databaseSha256After !== databaseIdentity.contentSha256) {
    throw new TypeError("production performance database/report content binding mismatch");
  }
  const sweep = readSweep(report, indexBinding.sweepByteLength);
  const terminalBinding = readFullFamilyTerminalBinding(report, indexBinding.terminalBindingByteLength);
  const activeGraph = observeFrozenPreReleaseBActiveReadyGraphV1(
    report.factLocators.frozenCheckpointSnapshotPublication,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.bCheckpointSnapshotPath,
  );
  return Object.freeze({ report, observation, sweep, activeGraph, terminalBinding });
}

/** Production complete-classification path. The opaque capability exists only
 * inside the frozen-B final runner; serialized reports and standalone CLI
 * invocations cannot reconstruct it. */
export function readPreReleaseFactLogV1(
  reportPath: string,
  terminalPhysicalCapability: PreReleaseBTerminalPhysicalObservationCapabilityV1,
): readonly PreReleaseFactLogRecordV1[] {
  if (arguments.length !== 2) throw new TypeError("pre-release FactLog requires the owner-issued terminal physical observation");
  const inputs = readPreReleaseFactLogInputsV1(reportPath);
  const terminalPhysical = readPreReleaseBTerminalPhysicalObservationV1(terminalPhysicalCapability);
  return buildObservedPreReleaseFactLogRecordsV1(
    inputs.report,
    inputs.observation,
    inputs.sweep,
    inputs.activeGraph,
    terminalPhysical,
    inputs.terminalBinding,
  );
}

/** Standalone advisory reader. It reopens the same physical artifacts but can
 * never claim root-owned fsync/process authority. */
export function readPreReleaseFactLogAdvisoryV1(
  reportPath: string,
): readonly PreReleaseFactLogRecordV1[] {
  const inputs = readPreReleaseFactLogInputsV1(reportPath);
  return buildObservedPreReleaseFactLogRecordsV1(
    inputs.report,
    inputs.observation,
    inputs.sweep,
    inputs.activeGraph,
    null,
    inputs.terminalBinding,
  );
}

/** Test-only structural path. It still reopens every report-owned physical
 * locator but can never emit a root-owned physical classification. */
export function readPreReleaseFactLogStructuralFixtureV1(
  reportPath: string,
  activeGraph: ProductionActiveReadyGraphSnapshotV1,
): readonly PreReleaseFactLogRecordV1[] {
  const canonicalReportPath = absolutePath(resolve(reportPath), "reportPath");
  const report = decodeReport(decodeCanonicalBytes(readPhysicalFile(canonicalReportPath, {})));
  const indexBinding = decodeIndexAndBind(report);
  const databaseIdentity = report.factLocators.processEvidenceDatabase;
  readPhysicalFile(databaseIdentity.path, {
    device: databaseIdentity.device,
    inode: databaseIdentity.inode,
    contentSha256: databaseIdentity.contentSha256,
  });
  const observation = observeProductionPerformanceDatabaseV1(report.factIndex.processEvidenceQuery.databasePath);
  const sweep = readSweep(report, indexBinding.sweepByteLength);
  const terminalBinding = readFullFamilyTerminalBinding(report, indexBinding.terminalBindingByteLength);
  return buildObservedPreReleaseFactLogRecordsV1(report, observation, sweep, activeGraph, null, terminalBinding);
}

export function encodePreReleaseFactLogJsonlV1(records: readonly PreReleaseFactLogRecordV1[]): Uint8Array {
  const lines = records.map(item => Buffer.from(encodeCanonicalBytes(item)).toString("utf8"));
  return Uint8Array.from(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}
